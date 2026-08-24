/**
 * The ORACLE: the original stratagems `JSProcessor`, driven over a captured
 * stream.
 *
 * This is what makes the golden states worth anything. The expected state is not
 * something we wrote down; it is computed by the handler bodies that have
 * actually been running on Base, vendored verbatim at commit `3d5a0b3f` (see
 * `../vendor/stratagems/README.md`, including why GPL-3.0 code sits in an MIT
 * repository). A reimplementation of the same logic would agree with the port
 * for exactly the reason that makes it worthless as evidence.
 *
 * The replay is `@etherfold/core`'s own `replayFixtureInto`, with no node in the
 * loop, so the oracle is driven exactly as production drives a processor and the
 * only bespoke part is the two lines that keep the state each block returned.
 */
import {replayFixtureInto, type EventProcessor, type LastSync, type LogEvent} from '@etherfold/core';
import {fromJSProcessor} from '@etherfold/js-processor';
import type {StratagemsABI} from '../vendor/stratagems/abi.js';
import {StratagemsIndexerProcessor, type Data} from '../vendor/stratagems/js-processor.js';
import {loadStream, type WorkloadFixture} from './fixtures.js';

/**
 * The stream config the capture ran under.
 *
 * `finality` only decides how much reorg history the js-processor's `History`
 * keeps while replaying; the fixture carries no retractions, so it changes
 * nothing about the state and is recorded here so a rerun is not a guess.
 */
const STREAM_CONFIG = {finality: 12} as const;

/**
 * Recompute a fixture's state with the original processor.
 *
 * Cheap enough to be a test rather than a chore: about 1.5 s for the launched
 * game's 31,332 events, because the original keeps its state in memory (immer)
 * and there is no store underneath it. Replaying the same events through a
 * versioned BACKEND, which is what the workload does, costs two orders of
 * magnitude more.
 */
export async function computeWithOracle(fixture: WorkloadFixture): Promise<Data> {
	const stream = loadStream(fixture);
	const oracle = fromJSProcessor(() => StratagemsIndexerProcessor)();
	oracle.configure(undefined);

	let state: Data | undefined;
	const recording: EventProcessor<StratagemsABI, Data> = {
		getVersionHash: () => oracle.getVersionHash(),
		getCodeFingerprint: () => oracle.getCodeFingerprint(),
		load: (source, config) => oracle.load(source, config),
		process: async (events: LogEvent<StratagemsABI>[], lastSync: LastSync<StratagemsABI>) =>
			(state = await oracle.process(events, lastSync)),
		reset: () => oracle.reset(),
		clear: () => oracle.clear(),
	};

	await replayFixtureInto(recording, stream, STREAM_CONFIG);
	if (!state) {
		throw new Error(`${fixture.name}: the oracle produced no state (the fixture carried no blocks)`);
	}
	return state;
}
