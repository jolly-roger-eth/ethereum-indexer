import 'fake-indexeddb/auto';
import {describe, expect, it} from 'vitest';
import {fromJSProcessor, type JSProcessor} from '@etherfold/js-processor';
import type {EntityProcessor} from '@etherfold/processor-entities';
import {createBrowserStateStore, createIndexerState} from '../src/index.js';
import {
	BRANCH_A_EXTENDED,
	BRANCH_A_EXTENDED_TIP,
	entityProcessorOver,
	EXPECTED_A,
	fakeChain,
	FINALITY,
	indexerForProcessor,
	processor,
	processorVariant,
	readState,
	SOURCE,
	SOURCE_REDEPLOYED_SAME_ABI,
	SOURCE_V2,
	START_BLOCK,
	indexToTip,
	type TestABI,
} from '../browser/workload.js';

/**
 * The two reload axes a hot-reloading template has to get right, DRIVEN.
 *
 * `updateProcessor` and `updateIndexer` have existed since `0.7.6` and no
 * application in the family has ever called either. The tests that existed
 * covered the browser layer's own bookkeeping -- that a reconfigure is
 * serialised, that the auto-index loop is paused, that stale syncing state is
 * cleared on success only -- against a processor fake whose `process` returns a
 * constant and whose `load` returns nothing. None of them could observe the
 * thing an integrator actually cares about: whether the STATE survives, and
 * whether that answer is the right one.
 *
 * So these run a real entity processor over a real store against a real captured
 * stream, and ask about the rows.
 *
 * The axes are independent, and the deployment shape is why. These apps deploy
 * behind a PROXY on local, so a redeploy does not move the address: axis two is
 * a new ABI at an address that already has indexed history. Axis one is the
 * developer editing the reducer, which the chain knows nothing about.
 */

let counter = 0;
const freshName = () => `reconfigure-${counter++}-${Math.random().toString(36).slice(2, 8)}`;

/** Index branch A to the tip, on a fresh IndexedDB database, with `definition`. */
async function indexedWith(definition = processor, chain = fakeChain()) {
	const store = await createBrowserStateStore(definition.entities, {databaseName: freshName()});
	const indexer = indexerForProcessor(store, definition);
	await indexer.init({provider: chain.provider, source: SOURCE, config: {stream: {finality: FINALITY}}});
	await indexToTip(indexer);
	return {store, indexer, chain};
}

// ---------------------------------------------------------------------------
// AXIS ONE: the developer edited the reducer, and Vite handed the tab a new
// processor module.
// ---------------------------------------------------------------------------

describe('axis one: swapping in an edited processor', () => {
	/**
	 * The trap, stated as a test: the version hash is AUTHOR-DECLARED, so editing
	 * a handler does not move it.
	 *
	 * `getVersionHash()` is `${version}-${hash({entities, config})}`. Handler code
	 * is in none of those three. An edit to a reducer therefore produces a
	 * processor the core considers IDENTICAL, and `updateProcessor` skips the swap
	 * entirely -- not "keeps the state and adopts the new logic", which is what an
	 * integrator reading the doc would assume, but keeps the OLD PROCESSOR OBJECT
	 * running. The edited module never executes.
	 */
	it('does nothing at all when the version did not move, and the edit never runs', async () => {
		const {store, indexer, chain} = await indexedWith();
		expect(await readState(indexer.state.$state)).toEqual(EXPECTED_A);

		// the developer edited the handler (now counts 10 per transfer) and did NOT
		// touch `version`, which is the default state of an edited file.
		const edited = processorVariant({version: '1.0.0', countBy: 10});
		const outcome = await indexer.updateProcessor({kind: 'entities', processor: entityProcessorOver(store, edited)});

		// and it SAYS it kept the state, which is what a caller branches on
		expect(outcome.stateDiscarded).toBe(false);
		// the stored rows are untouched...
		expect(await readState(indexer.state.$state)).toEqual(EXPECTED_A);

		// ...and so is the logic. The chain moves on by one event; under the edited
		// handler the counter would go 5 -> 15, under the old one 5 -> 6.
		chain.serve(BRANCH_A_EXTENDED, BRANCH_A_EXTENDED_TIP);
		await indexToTip(indexer);

		const after = await readState(indexer.state.$state);
		expect(after.transfers).toBe(6);
		expect(after.transfers).not.toBe(15);

		indexer.dispose();
	});

	/**
	 * The same edit with the version bumped: the state is discarded and rebuilt by
	 * the NEW logic, from the start block.
	 *
	 * Note what makes this assertable: every block is re-indexed under the edited
	 * handler, so the counter is 5 * 10 and not 5 + something. A rebuild that had
	 * kept the old rows and merely continued would show 50 nowhere.
	 */
	it('rebuilds the whole state under the new logic when the version was bumped', async () => {
		const {store, indexer, chain} = await indexedWith();
		expect(await readState(indexer.state.$state)).toEqual(EXPECTED_A);
		const rangesBefore = chain.ranges.length;

		const edited = processorVariant({version: '2.0.0', countBy: 10});
		const outcome = await indexer.updateProcessor({kind: 'entities', processor: entityProcessorOver(store, edited)});
		expect(outcome.stateDiscarded).toBe(true);

		// the swap cleared the store, so the very next fetch goes back to the start
		// block rather than resuming from the cursor
		await indexToTip(indexer);
		expect(chain.ranges.slice(rangesBefore)[0].from).toBe(START_BLOCK);

		const after = await readState(indexer.state.$state);
		expect(after.owners).toEqual(EXPECTED_A.owners);
		expect(after.transfers).toBe(50);

		indexer.dispose();
	});

	/**
	 * `{force: true}` is the escape hatch for an integrator who knows the logic
	 * changed and cannot make the author bump a string.
	 *
	 * It costs the same full rebuild a bump costs, because the core cannot know
	 * which parts of the state the edit invalidated -- so it invalidates all of
	 * it, which is the only answer that cannot be wrong.
	 */
	it('force rebuilds even when the version did not move', async () => {
		const {store, indexer} = await indexedWith();

		const edited = processorVariant({version: '1.0.0', countBy: 10});
		const outcome = await indexer.updateProcessor(
			{kind: 'entities', processor: entityProcessorOver(store, edited)},
			{force: true},
		);
		expect(outcome.stateDiscarded).toBe(true);
		await indexToTip(indexer);

		expect((await readState(indexer.state.$state)).transfers).toBe(50);
		indexer.dispose();
	});
});

// ---------------------------------------------------------------------------
// AXIS TWO: the implementation behind the proxy changed. Same address, new ABI,
// and the chain keeps every block the old implementation wrote.
// ---------------------------------------------------------------------------

describe('axis two: a new implementation behind the same address', () => {
	/**
	 * A changed ABI at an unchanged address DOES invalidate, because the ABI is
	 * hashed into the source.
	 *
	 * This is the branch `deployments-store.ts` can take with confidence: hand
	 * `updateIndexer` the new source and the core discards and re-indexes. No
	 * `reset()` is needed alongside it, and calling one would be a second full
	 * rebuild rather than a safety net.
	 */
	it('discards and re-indexes when the regenerated ABI differs', async () => {
		const {indexer, chain} = await indexedWith();
		expect(await readState(indexer.state.$state)).toEqual(EXPECTED_A);
		const rangesBefore = chain.ranges.length;

		const outcome = await indexer.updateIndexer({source: SOURCE_V2 as never});
		expect(outcome.stateDiscarded).toBe(true);
		await indexToTip(indexer);

		// it went back to the start block rather than resuming from the cursor
		const askedAfter = chain.ranges.slice(rangesBefore);
		expect(askedAfter[0].from).toBe(START_BLOCK);
		expect(await readState(indexer.state.$state)).toEqual(EXPECTED_A);

		indexer.dispose();
	});

	/**
	 * A redeploy whose ABI did not change is indistinguishable from no redeploy at
	 * all, and that is the RIGHT answer rather than a gap.
	 *
	 * The source hash is over the ABI, the address, the start block and the chain
	 * id, so an implementation whose event signatures did not move leaves all four
	 * alone. If nothing about the contract's interface changed, the previously
	 * indexed rows are still what those logs mean, and discarding them would be
	 * pure cost.
	 *
	 * The case that looks like a gap -- the implementation changed what its events
	 * MEAN while keeping their signatures -- is not one, because it is not
	 * reachable without a PROCESSOR change: new meaning has to be implemented by
	 * new handler code, and that is the developer's job and nobody else's. It
	 * therefore travels axis one, above: bump `version`, and the state is discarded
	 * and rebuilt. There is no second mechanism and no `reset()` special case.
	 *
	 * See the sibling test below for the one thing that genuinely does not follow
	 * from that.
	 */
	it('keeps everything when the redeployed ABI is identical, which is correct', async () => {
		const {indexer, chain} = await indexedWith();
		const rangesBefore = chain.ranges.length;

		const outcome = await indexer.updateIndexer({source: SOURCE_REDEPLOYED_SAME_ABI});
		// nothing to report, because nothing about the source moved
		expect(outcome.stateDiscarded).toBe(false);
		await indexToTip(indexer);

		const askedAfter = chain.ranges.slice(rangesBefore);
		expect(askedAfter[0].from).toBeGreaterThan(START_BLOCK);
		expect(await readState(indexer.state.$state)).toEqual(EXPECTED_A);

		indexer.dispose();
	});

	/**
	 * What a rebuild does NOT do for you: a re-index replays the WHOLE history,
	 * including the blocks the previous implementation wrote.
	 *
	 * This is the part of an upgrade that no version bump can get right on its own,
	 * and it is the reason the meaning question is a processor question. Discarding
	 * and rebuilding runs every block back through the CURRENT handler, so a
	 * handler that simply implements the new meaning silently reinterprets
	 * pre-upgrade history under post-upgrade rules -- here that would be 5 * 10 = 50
	 * rather than the 3 + 20 that actually happened.
	 *
	 * The upgrade block is the developer's own knowledge, and expressing it is
	 * ordinary handler code: `event.blockNumber` is on every event. A chain whose
	 * history is disposable (a local node restarted with each deploy) never meets
	 * this; one that keeps its history always does.
	 */
	it('replays pre-upgrade blocks too, so a handler that must span an upgrade branches on the block', async () => {
		const UPGRADE_BLOCK = 103;

		/** The same processor, taught where the implementation changed underneath it. */
		const spanningUpgrade: EntityProcessor<TestABI> = {
			version: '2.0.0',
			entities: processor.entities,
			async onTransfer(state, event) {
				state.set('token', {id: event.args.id.toString()}, {owner: event.args.to});
				const counter = await state.get<{value: number}>('counter', {name: 'transfers'});
				// before the upgrade these logs meant one thing, after it another
				const weight = event.blockNumber >= UPGRADE_BLOCK ? 10 : 1;
				state.set('counter', {name: 'transfers'}, {value: (counter?.value ?? 0) + weight});
			},
		};

		const {store, indexer} = await indexedWith();
		expect((await readState(indexer.state.$state)).transfers).toBe(5);

		await indexer.updateProcessor({kind: 'entities', processor: entityProcessorOver(store, spanningUpgrade)});
		await indexToTip(indexer);

		// blocks 100 and 102 carry three transfers under the OLD meaning, block 104
		// carries two under the new one
		expect((await readState(indexer.state.$state)).transfers).toBe(3 + 20);
		// and emphatically not the whole history reinterpreted
		expect((await readState(indexer.state.$state)).transfers).not.toBe(50);

		indexer.dispose();
	});
});

// ---------------------------------------------------------------------------
// The copy of the state that a UI actually renders.
// ---------------------------------------------------------------------------

/**
 * What `$state` holds after a discard, which is a different question from what
 * the PROCESSOR holds.
 *
 * The core discards state by resetting the processor and loading again, and
 * `onStateUpdated` fires when a state is ADOPTED or PRODUCED -- a discard is
 * neither. So every subscriber's copy (a Svelte store, a React hook, anything
 * that rendered once) went on showing the discarded state until an event
 * happened to arrive and overwrite it.
 *
 * These run on the free-form kind because that is where it is unambiguous: its
 * `$state` is the state VALUE, so a stale copy shows stale numbers. The entity
 * kind publishes a read HANDLE, which hides the same defect behind a store that
 * was cleared underneath it -- until the handle points at a different store,
 * which is what a declarations change makes it do.
 */
type NFTState = {transfers: number; owners: {[id: string]: string}};

function jsProcessor(version: string, countBy: number): JSProcessor<TestABI, NFTState> {
	return {
		version,
		construct: () => ({transfers: 0, owners: {}}),
		onTransfer(json, event) {
			json.owners[event.args.id.toString()] = event.args.to;
			json.transfers += countBy;
		},
	};
}

async function jsIndexerOnBranchA(chain = fakeChain()) {
	const indexer = createIndexerState<TestABI, NFTState>(fromJSProcessor(jsProcessor('1.0.0', 1))());
	await indexer.init({provider: chain.provider, source: SOURCE, config: {stream: {finality: FINALITY}}});
	await indexToTip(indexer as never);
	return {indexer, chain};
}

describe('the state a subscriber is holding, after a discard', () => {
	/**
	 * The redeploy with nothing to replay, which is the local-development case
	 * this whole feature exists for.
	 *
	 * The developer edits a contract; it is redeployed behind the proxy; the new
	 * implementation has emitted nothing yet. The indexer correctly throws the old
	 * state away and correctly finds no events. If the hook does not re-seed, there
	 * is no next event to correct it, so the tab renders state computed from the
	 * contract that is no longer deployed for the rest of the session -- silently,
	 * and looking exactly like a working app.
	 */
	it('does not keep publishing the old state when a redeploy has nothing to replay', async () => {
		const {indexer, chain} = await jsIndexerOnBranchA();
		expect(indexer.state.$state.transfers).toBe(5);

		// redeployed behind the proxy: a new ABI at the same address, and a chain
		// that has not emitted anything through it yet.
		chain.serve([], 120);
		await indexer.updateIndexer({source: SOURCE_V2 as never});
		await indexToTip(indexer as never);

		expect(indexer.state.$state).toEqual({transfers: 0, owners: {}});
		indexer.dispose();
	});

	/** The same, reached through the other axis: an edited processor, bumped. */
	it('does not keep publishing the old state after a processor swap with nothing to replay', async () => {
		const {indexer, chain} = await jsIndexerOnBranchA();
		expect(indexer.state.$state.transfers).toBe(5);

		chain.serve([], 120);
		await indexer.updateProcessor(fromJSProcessor(jsProcessor('2.0.0', 10))());
		await indexToTip(indexer as never);

		expect(indexer.state.$state).toEqual({transfers: 0, owners: {}});
		indexer.dispose();
	});

	/**
	 * The discard is published at the MOMENT of the swap, not merely by the time
	 * indexing catches up.
	 *
	 * A UI renders on every store notification, so "it is corrected eventually" is
	 * not the same claim: an app that paints between the swap and the first
	 * re-indexed block paints the old contract's numbers.
	 */
	it('publishes the discard immediately, before anything is re-indexed', async () => {
		const {indexer} = await jsIndexerOnBranchA();

		await indexer.updateProcessor(fromJSProcessor(jsProcessor('2.0.0', 10))());

		expect(indexer.state.$state).toEqual({transfers: 0, owners: {}});
		indexer.dispose();
	});

	/**
	 * And the converse, which is what stops the fix from being "blank it on every
	 * reconfigure": a reconfigure that kept the state must not blank it.
	 *
	 * A same-version swap is skipped by the core, so the state is still valid and
	 * still on screen. Re-seeding here would be its own silent bug -- a UI that
	 * empties itself when a developer saves a file that changed nothing.
	 */
	it('leaves the state alone when the reconfigure did not discard it', async () => {
		const {indexer} = await jsIndexerOnBranchA();

		// same version: the core skips the swap and keeps the running processor
		await indexer.updateProcessor(fromJSProcessor(jsProcessor('1.0.0', 10))());
		expect(indexer.state.$state.transfers).toBe(5);

		// a source that hashes the same: no reset, so no discard
		await indexer.updateIndexer({source: SOURCE_REDEPLOYED_SAME_ABI});
		expect(indexer.state.$state.transfers).toBe(5);

		indexer.dispose();
	});

	/** `reset()` is a discard by definition, and was silent in the same way. */
	it('publishes the discard on an explicit reset', async () => {
		const {indexer, chain} = await jsIndexerOnBranchA();
		expect(indexer.state.$state.transfers).toBe(5);

		chain.serve([], 120);
		await indexer.reset();

		expect(indexer.state.$state).toEqual({transfers: 0, owners: {}});
		indexer.dispose();
	});
});
