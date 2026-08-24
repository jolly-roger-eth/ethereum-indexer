import type {EntityProcessor} from '@etherfold/processor-entities';
import eip721 from './eip721.js';

/**
 * The same question as `index.ts` -- who owns which token -- written against the
 * STORAGE SEAM instead of against a free-form object.
 *
 * This is the processor the browser demo in `browser/` runs, and it is the whole
 * point of the example: it names no backend. The deployment decides where the
 * state lives (versioned rows in IndexedDB in a tab, SQLite on a server, the
 * light patch store for a tab that only wants the tip), and nothing below
 * changes when it does.
 *
 * `index.ts` keeps the free-form `JSProcessor` version of the same logic. Two
 * processors in one example is deliberate and is the one place in this
 * repository where the SAME indexing question is written in both authoring
 * styles, so the cost of porting one to the other is readable in a diff. The
 * shapes are almost identical on purpose: `on<EventName>(state, event, config)`
 * either way, and only the WRITES differ -- `data.nfts.push(...)` against a draft
 * object here becomes `state.set(entity, id, values)` against a
 * `MutationContext`.
 */

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * The token id, as an id COLUMN.
 *
 * Padded to a fixed width because a listing is ordered lexicographically over
 * the stringified id (ADR-0021), so an unpadded decimal would sort `10` before
 * `9`. 78 digits is `uint256`'s decimal width; nothing is lost, and the display
 * side strips the zeros back off.
 */
function tokenKey(id: bigint): string {
	return id.toString().padStart(78, '0');
}

/** The inverse, for a UI. */
export function readableTokenID(key: string): string {
	return key.replace(/^0+(?=\d)/, '');
}

export const NFTProcessor: EntityProcessor<typeof eip721> = {
	// REQUIRED: the identity of this processor's LOGIC. State computed by a
	// previous version is discarded by comparing it, so bump it whenever a handler
	// changes. The entity declarations below are hashed in alongside it, so a
	// SCHEMA change invalidates on its own; a handler change does not.
	version: '1.0.0',

	/**
	 * `{name, id, fields}` per entity, and that is the whole schema an author
	 * writes: the store owns the layout, the version columns, the as-of read and
	 * the reorg revert.
	 *
	 * `nft` is keyed by `(tokenAddress, tokenID)`, which makes "the tokens of this
	 * collection" a PREFIX of the id and therefore one indexed range scan on every
	 * backend -- the seam's only set read.
	 */
	entities: [
		{name: 'nft', id: ['tokenAddress', 'tokenID'], fields: {owner: 'text'}},
		{name: 'counter', id: ['name'], fields: {value: 'integer'}},
	],

	async onTransfer(state, event) {
		// lower-cased on the way in so a caller can query the prefix without having
		// to reproduce viem's EIP-55 checksum casing
		const tokenAddress = event.address.toLowerCase();
		const tokenID = tokenKey(event.args.id);

		if (event.args.to.toLowerCase() === ZERO_ADDRESS) {
			// burnt: the live version is closed and no new one opened
			state.delete('nft', {tokenAddress, tokenID});
		} else {
			state.set('nft', {tokenAddress, tokenID}, {owner: event.args.to});
		}

		// read-your-writes inside the block: two transfers in one block compose
		const counter = await state.get<{value: number}>('counter', {name: 'transfers'});
		state.set('counter', {name: 'transfers'}, {value: (counter?.value ?? 0) + 1});
	},
};

/** The ABI, re-exported so an app names one import for the processor and its events. */
export {default as abi} from './eip721.js';
