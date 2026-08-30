/**
 * The stream a promotion is measured over.
 *
 * The base is the captured launched game (`stratagems-alpha1`, 31,332 real
 * logs, 23.2 MB of JSON), the same fixture `docs/spikes/sqlite-in-the-browser`
 * uses, so the shape of an event is real rather than invented. Larger sizes are
 * that stream repeated with its block numbers advanced, which keeps the per-event
 * payload honest while reaching a history worth worrying about.
 */
import type {Segment} from './layouts.js';

export type Size = '1x' | '2x' | '4x' | '8x' | '16x';
export const SIZES: Size[] = ['1x', '2x', '4x', '8x', '16x'];
export const REPEATS: Record<Size, number> = {'1x': 1, '2x': 2, '4x': 4, '8x': 8, '16x': 16};

export type Fixture = {lastSync: unknown; eventStream: any[]};

/**
 * Cut a stream into segments of at most `sealAfter` events.
 *
 * The threshold is in EVENTS, not bytes, because that is what
 * `appending-to-the-stream-costs-the-batch` pins: bytes are natural on the
 * filesystem and not cheaply available on IndexedDB, so naming the unit is what
 * stops the two keepers choosing differently.
 *
 * Every segment carries the `lastSync` current when it was written, which is
 * what makes each one an atomic snapshot at its own boundary.
 */
export function segmentise(fixture: Fixture, repeat: number, sealAfter: number): Segment[] {
	const base = fixture.eventStream;
	const blockSpan = (base[base.length - 1]?.blockNumber ?? 0) - (base[0]?.blockNumber ?? 0) + 1;

	const segments: Segment[] = [];
	let current: any[] = [];
	for (let r = 0; r < repeat; r++) {
		const offset = r * blockSpan;
		for (const event of base) {
			current.push(offset === 0 ? event : {...event, blockNumber: event.blockNumber + offset});
			if (current.length >= sealAfter) {
				segments.push({lastSync: fixture.lastSync, eventStream: current});
				current = [];
			}
		}
	}
	if (current.length > 0) segments.push({lastSync: fixture.lastSync, eventStream: current});
	return segments;
}

/**
 * The three sharing cases, which decide HOW MUCH staging wrote and therefore
 * what promotion costs. Which case applies is decided by the invalidation
 * verdict, never chosen.
 */
export type SharingCase = 'whole-stream' | 'partial-graft' | 'no-sharing';

/**
 * Where the graft point sits, as a fraction of the live stream, per case.
 *
 * - `whole-stream` (a processor-only or decode-only change): staging writes
 *   NOTHING at all, so the graft point is the live tail.
 * - `partial-graft` (an event added or edited below the cursor): staging rewrites
 *   the part above the boundary. Half is an arbitrary but stated choice.
 * - `no-sharing` (a changed address, a new contract): the block-0 skeleton entry
 *   moved, so nothing beneath is valid and staging rewrites everything.
 */
export const GRAFT_FRACTION: Record<SharingCase, number> = {
	'whole-stream': 1,
	'partial-graft': 0.5,
	'no-sharing': 0,
};
