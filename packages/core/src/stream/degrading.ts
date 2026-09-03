import type {Abi} from 'abitype';
import {logs} from 'named-logs';
import type {ExistingStream, IndexingSource} from '../types.js';

const namedLogger = logs('@etherfold/core');

/**
 * A STREAM THAT CANNOT BE READ COSTS A RE-INDEX, NOT THE INDEXER: an
 * `ExistingStream` whose READ side reports ABSENT instead of raising.
 *
 * ## Why the read side may not raise
 *
 * `fetchFrom` and `clear` are called from `IndexerGeneration`'s load path (and
 * from `promiseToFollow`) with no `try`/`catch` anywhere above them, so a keeper
 * that raises from either does not degrade a cache -- it makes `load()` reject,
 * on this boot and on every boot after it, for a LOCAL CACHE whose correct
 * recovery is to throw the bytes away and index again. That is the difference
 * between a slow app and a dead one, and it is story 12 of
 * `a-reconfigure-is-not-an-outage`.
 *
 * The rule is not new. A keeper already CLEARS the damage it can inspect (a gap
 * in the ordinals, a segment that does not parse, a cursor with no segments) and
 * reports absent rather than throwing, precisely because of that call site. This
 * is the same rule extended to the damage it CANNOT inspect: a substrate that is
 * simply unavailable -- IndexedDB refused in private browsing, storage evicted, a
 * database at a version this build cannot open. Absent is the honest answer for
 * both, and it is the one the load path already knows what to do with: it clears
 * and re-indexes from the source's first block.
 *
 * ## Why the WRITE side is deliberately NOT covered
 *
 * `saveNewEvents` raises THROUGH. Its call site is the one that catches
 * (`IndexerGeneration.promiseToSave`), and what it does with the failure is
 * load-bearing: it counts it, paces the retry, FREEZES the cache once there have
 * been too many -- and until then it does not process the batch at all. A
 * swallowed write failure would report success to that caller, so the state
 * would advance past events the stream never received, and the stream's cursor
 * would then claim coverage of a range whose events are absent. That is a HOLE
 * (`CONTEXT.md`), which no later check can see and which no reload repairs.
 *
 * So the asymmetry is not an oversight and must not be "fixed": a failure is
 * swallowed exactly where nobody is listening for it, and reported exactly where
 * somebody acts on it.
 *
 * ## Where it is applied
 *
 * Inside `createSegmentedStream`, so every keeper built over the segment port
 * inherits it with the rest of the rules; and again around a keeper that makes
 * substrate calls of its OWN outside that helper (the browser keeper's legacy
 * blob probe). Wrapping twice is harmless and never doubles a log line: the
 * inner one answers `undefined` rather than raising, so the outer one never sees
 * a failure the inner one already handled.
 */
export function degradingStream<ABI extends Abi>(stream: ExistingStream<ABI>): ExistingStream<ABI> {
	const setStreamConfig = stream.setStreamConfig?.bind(stream);

	function degraded(operation: string, source: IndexingSource<ABI>, error: unknown): void {
		namedLogger.error(
			`the cached stream could not be ${operation} on chain ${source.chainId}: ${error}. It is treated as ABSENT, ` +
				`so this generation re-indexes from its start block rather than failing to load at all -- a cache is an ` +
				`optimisation and must never wedge the indexer.`,
			error,
		);
	}

	return {
		async fetchFrom(source, fromBlock) {
			try {
				return await stream.fetchFrom(source, fromBlock);
			} catch (error) {
				degraded('read', source, error);
				// the SAME answer a never-written stream gives, which is why it is the safe
				// one: the load path clears and re-indexes on it
				return undefined;
			}
		},
		// NOT guarded, deliberately. See the JSDoc above: `promiseToSave` acts on this
		// failure, and a swallowed one would let the state advance past events the
		// stream never received. `async` only so that a keeper which throws
		// SYNCHRONOUSLY still hands its caller the REJECTED PROMISE this seam is typed
		// to return; the failure itself is untouched.
		saveNewEvents: async (source, streamToSave) => stream.saveNewEvents(source, streamToSave),
		async clear(source) {
			try {
				await stream.clear(source);
			} catch (error) {
				// `fetchFrom` reporting absent is what MAKES the caller clear, so a raising
				// `clear` would put the outage back one line further down. There is nothing
				// to do about it either: a substrate that cannot be read cannot be emptied.
				degraded('cleared', source, error);
			}
		},
		...(setStreamConfig ? {setStreamConfig} : {}),
	};
}
