import type {Abi, EventProcessor, IndexingSource, ProvidedStreamConfig} from '@etherfold/core';
import type {EntityProcessor, StateStore} from '@etherfold/processor-entities';
import {loadContracts} from '@etherfold/utils';
import type {RemoteSQL} from 'remote-sql';
import type {ExplicitSource, StoreTarget} from './types.js';

// ---------------------------------------------------------------------------------------------------
// THE FOLDING ASSEMBLY EVERY COMMAND THAT OWNS A DATABASE SHARES
// ---------------------------------------------------------------------------------------------------
// Three of the five commands fold: `run` and `build` fetch what they fold,
// `index` receives it. What differs between them is where the batches come
// FROM -- a `LogFetcher` on this side of a direct in-process wire, or a sender
// on the other side of an HTTP one -- and what is IDENTICAL is everything below
// the stream-builder: one stream configuration, one store, one processor, one
// database handle. So it lives here rather than in any one command's module,
// which is the file-level form of "no component is implemented twice".
// ---------------------------------------------------------------------------------------------------

/**
 * The stream configuration every command indexes under.
 *
 * Deliberately empty, and deliberately shared: the RESOLVED object is hashed
 * into the wire identity, so a sending `LogFetcher` and a receiving
 * `StreamBuilder` must reach the same `finality` from the same input -- which
 * for a split deployment means the sender's and the receiver's must be the same
 * object, and not two empties that happen to agree. Its resolved form is also
 * what the entity store's retention floor is checked against, which is why
 * nothing here writes a finality number of its own.
 */
export const STREAM_CONFIG: ProvidedStreamConfig = {};

/**
 * Turn a source ORIGIN a chain-free command resolved into the source itself.
 *
 * Two arms and no third, which is the type talking: the module route is the only
 * one that can cost an `eth_chainId` call, so a command that makes no chain call
 * has already refused it by name (`requireExplicitSource`). Both `fetch` (no
 * processor module to read a source out of) and `index` (no node to ask) land
 * here, for different reasons and on the same two arms.
 */
export async function openExplicitSource<ABI extends Abi>(origin: ExplicitSource<ABI>): Promise<IndexingSource<ABI>> {
	switch (origin.from) {
		case 'deployments':
			return loadContracts<ABI>(origin.folder);
		case 'INDEXING_SOURCE':
			return origin.source;
	}
}

/**
 * Build the `EventProcessor` a stream-builder drives, plus the store it writes
 * to and the ONE database handle underneath both.
 *
 * The handle is returned rather than kept, because a command that also serves
 * hands this SAME object to the server (`platforms/nodejs`'s `StartOptions.db`
 * takes one): the store and the read surface then see one database rather than
 * two connections with two views of it -- against `:memory:` they would not even
 * be the same database.
 *
 * The imports are dynamic so that a command which never opens a database does
 * not pay for libSQL, matching how `serve` keeps the server's dependency tree
 * off `build`.
 */
export async function buildProcessor<ABI extends Abi, ProcessResultType>(
	declared: EntityProcessor<ABI, any>,
	target: StoreTarget,
	context: {finalityDepth: number; createDB?: (url: string) => RemoteSQL},
): Promise<{processor: EventProcessor<ABI, ProcessResultType>; store: StateStore; db: RemoteSQL}> {
	const [{EntityEventProcessor}, {VersionedStateStore}, {createNodeDB}] = await Promise.all([
		import('@etherfold/processor-entities'),
		import('@etherfold/state-store-sqlite'),
		import('@etherfold/platform-nodejs'),
	]);

	const handle = context.createDB ? context.createDB(target.db) : createNodeDB(target.db);
	// The finality depth is the stream's own, resolved by the caller from
	// `STREAM_CONFIG`: a retention window is validated against the depth a reorg
	// can actually reach, and a number written here instead would be a second
	// opinion about it.
	const store = new VersionedStateStore(handle, declared.entities, {
		retention: target.retention,
		finalityDepth: context.finalityDepth,
	});
	// No cursor of our own: the store holds the rows and the cursor in one
	// transaction, and the stream-builder reads that persisted cursor on every
	// call. Nothing here prunes: pruning is a call a host schedules (ADR-0022), and
	// one inside the index loop would stall whichever block crossed the threshold.
	const processor = new EntityEventProcessor<ABI, any>(store, declared, {
		finalityDepth: context.finalityDepth,
	});
	return {processor: processor as unknown as EventProcessor<ABI, ProcessResultType>, store, db: handle};
}
