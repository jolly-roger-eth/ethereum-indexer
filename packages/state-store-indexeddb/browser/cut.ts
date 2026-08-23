/**
 * The code under test, bundled into a real browser page.
 *
 * Everything asserted about this backend on a real engine runs from here, and
 * the Playwright specs beside it decide what to ask for and what to assert. The
 * cases:
 *
 * - `conformance`: the SHARED suite (`@etherfold/state-store-conformance`), the
 *   same one node runs, against this backend under all three retention claims.
 *   This is what "passes the conformance suite in a real browser, on Chromium,
 *   Firefox and WebKit" means: not a browser-flavoured copy of the cases, the
 *   cases themselves.
 * - `processor`: the SAME `EntityProcessor` the spec runs in node against
 *   `MemoryStateStore`, run here against IndexedDB, so the two can be compared
 *   row for row.
 * - `access-path`: the listing's `IDBKeyRange`, read off the real engine's own
 *   `IDBObjectStore.openCursor` rather than off a shim.
 * - `write` / `read` phases: persistence across a REAL page reload, which is the
 *   thing no node test can show.
 * - `multi-tab`: one database, four tabs, each writing its own blocks. This is
 *   the case both wasm-SQLite VFSs fail at open.
 */
import type {CodeUnderTest, RunContext, RunResult, Timing} from 'playwright-browser-harness/contract';
import {captureEnv, timed} from 'playwright-browser-harness/contract';
import {MemoryStateStore, type EntityDeclaration, type StateStore} from '@etherfold/state-store';
import {runStateStoreConformance} from '@etherfold/state-store-conformance';
import {deleteDatabase, IndexedDBStateStore} from '../src/index.js';
import {processor, runWorkload} from './workload.js';

type Params = Record<string, unknown>;

const TOKEN: EntityDeclaration = {name: 'token', id: ['id'], fields: {owner: 'text', transferCount: 'integer'}};

function databaseName(params: Params, suffix: string): string {
	return `${(params.tag as string) ?? 'etherfold-browser'}-${suffix}`;
}

/**
 * The shared suite, under each claim this backend can honestly make.
 *
 * Every case gets its own database, because every case gets its own store and on
 * this backend those are the same sentence.
 */
async function conformance(params: Params, timings: Timing[]): Promise<Record<string, unknown>> {
	const claims: {claim: string; options: Record<string, unknown>}[] = [
		{claim: 'unbounded', options: {}},
		{claim: 'window-128', options: {retention: {blocks: 128}, finalityDepth: 64}},
		{claim: 'revert-only', options: {retention: 'revert-only', finalityDepth: 64}},
	];

	const results: Record<string, unknown> = {};
	let failures: {claim: string; group: string; name: string; error: string}[] = [];
	let passed = 0;

	for (const {claim, options} of claims) {
		let sequence = 0;
		const result = await timed(`conformance:${claim}`, timings, () =>
			runStateStoreConformance(
				(declarations) =>
					new IndexedDBStateStore(declarations, {
						databaseName: `${databaseName(params, claim)}-${sequence++}`,
						...options,
					}),
			),
		);
		passed += result.passed;
		failures = failures.concat(
			result.failures.map((failure) => ({
				claim,
				group: failure.group,
				name: failure.name,
				error: `${(failure.error as Error)?.message ?? failure.error}`,
			})),
		);
		results[claim] = {passed: result.passed, failed: result.failures.length, databases: sequence};
	}

	return {passed, failed: failures.length, failures, byClaim: results};
}

/** The same processor as on the server, on this backend, in this engine. */
async function sameProcessor(params: Params, timings: Timing[]): Promise<Record<string, unknown>> {
	const name = databaseName(params, 'processor');
	await deleteDatabase(name).catch(() => undefined);
	const store = new IndexedDBStateStore(processor.entities, {databaseName: name});
	await store.migrate();
	try {
		return {...(await timed('processor', timings, () => runWorkload(store)))};
	} finally {
		await store.close();
	}
}

/**
 * The listing's access path, on the engine itself.
 *
 * `IDBObjectStore.prototype.openCursor` is patched for the duration of one
 * listing and the range it was given is reported back, so the assertion that the
 * seam's set read is a bounded key range and not a scan is made against
 * Chromium, Firefox and WebKit rather than against a node shim.
 */
async function accessPath(params: Params): Promise<Record<string, unknown>> {
	const name = databaseName(params, 'access-path');
	await deleteDatabase(name).catch(() => undefined);
	const store = new IndexedDBStateStore(
		[{name: 'placement', id: ['epoch', 'position', 'playerIndex'], fields: {player: 'text'}}],
		{databaseName: name},
	);
	await store.migrate();

	const mutations = [];
	for (let epoch = 1; epoch <= 50; epoch++) {
		for (let position = 0; position < 4; position++) {
			mutations.push({
				type: 'upsert' as const,
				entity: 'placement',
				id: {epoch, position, playerIndex: 0},
				values: {player: `0x${epoch}-${position}`},
			});
		}
	}
	await store.applyBlock({number: 100, hash: '0x64', timestamp: 1_700_000_000}, mutations);

	const opened: {lower: unknown; upper: unknown; lowerOpen: boolean; upperOpen: boolean; on: string}[] = [];
	let visited = 0;
	const openCursor = IDBObjectStore.prototype.openCursor;
	const advance = IDBCursor.prototype.continue;
	IDBObjectStore.prototype.openCursor = function patched(this: IDBObjectStore, query?: unknown, direction?: unknown) {
		if (query instanceof IDBKeyRange) {
			opened.push({
				on: this.name,
				lower: query.lower,
				upper: query.upper,
				lowerOpen: query.lowerOpen,
				upperOpen: query.upperOpen,
			});
		} else {
			opened.push({on: this.name, lower: null, upper: null, lowerOpen: false, upperOpen: false});
		}
		return openCursor.call(this, query as never, direction as never);
	} as typeof openCursor;
	IDBCursor.prototype.continue = function patched(this: IDBCursor, key?: unknown) {
		visited++;
		return advance.call(this, key as never);
	} as typeof advance;

	try {
		const listing = await store.listCurrent<Record<string, unknown>>('placement', {epoch: 7}, 10);
		return {opened, visited, rows: listing.rows.length, truncated: listing.truncated};
	} finally {
		IDBObjectStore.prototype.openCursor = openCursor;
		IDBCursor.prototype.continue = advance;
		await store.close();
	}
}

/** Write rows a reload has to find again. */
async function writePhase(params: Params, timings: Timing[]): Promise<Record<string, unknown>> {
	const name = databaseName(params, 'persist');
	await deleteDatabase(name).catch(() => undefined);
	const store = new IndexedDBStateStore([TOKEN], {databaseName: name});
	await store.migrate();
	try {
		await timed('write', timings, async () => {
			for (let number = 100; number < 140; number++) {
				await store.applyBlock({number, hash: `0x${number.toString(16)}`, timestamp: 1_700_000_000 + number * 12}, [
					{type: 'upsert', entity: 'token', id: {id: '1'}, values: {owner: `0x${number}`, transferCount: number - 99}},
				]);
			}
		});
		return {current: await store.getCurrent('token', {id: '1'})};
	} finally {
		await store.close();
	}
}

/** After a real reload: the rows, the history, and what the cold start cost. */
async function readPhase(params: Params, timings: Timing[]): Promise<Record<string, unknown>> {
	const store = new IndexedDBStateStore([TOKEN], {databaseName: databaseName(params, 'persist')});
	try {
		await timed('cold-start', timings, () => store.migrate());
		const current = await timed('read', timings, () => store.getCurrent('token', {id: '1'}));
		const historical = await store.getAsOf('token', {id: '1'}, 120);
		return {current, historical};
	} finally {
		await store.close();
	}
}

/**
 * One tab of a multi-tab run: its own heights, into the database they share.
 *
 * Each tab writes a block range of its own and then reads back EVERY tab's rows,
 * so a tab that could not open the database, or that lost a write to another
 * tab's transaction, shows up as a mismatch rather than as a slow run.
 */
async function multiTab(params: Params, timings: Timing[]): Promise<Record<string, unknown>> {
	const tab = params.tab as number;
	const tabs = params.tabs as number;
	const blocks = (params.blocks as number) ?? 20;
	const store = new IndexedDBStateStore([TOKEN], {databaseName: databaseName(params, 'multi-tab')});
	await store.migrate();

	try {
		await timed(`tab-${tab}`, timings, async () => {
			for (let index = 0; index < blocks; index++) {
				const number = 1_000 + index * tabs + tab;
				await store.applyBlock({number, hash: `0x${number.toString(16)}`, timestamp: 1_700_000_000 + number * 12}, [
					{
						type: 'upsert',
						entity: 'token',
						id: {id: `tab-${tab}-${index}`},
						values: {owner: `0x${tab}`, transferCount: index},
					},
				]);
			}
		});

		let mine = 0;
		for (let index = 0; index < blocks; index++) {
			const row = await store.getCurrent<{owner: string}>('token', {id: `tab-${tab}-${index}`});
			if (row?.owner === `0x${tab}`) mine++;
		}
		return {tab, wrote: blocks, readBack: mine, mismatches: blocks - mine};
	} finally {
		await store.close();
	}
}

/** After every tab has finished: does one connection see all of their rows? */
async function multiTabAudit(params: Params): Promise<Record<string, unknown>> {
	const tabs = params.tabs as number;
	const blocks = (params.blocks as number) ?? 20;
	const store = new IndexedDBStateStore([TOKEN], {databaseName: databaseName(params, 'multi-tab')});
	await store.migrate();
	try {
		let found = 0;
		for (let tab = 0; tab < tabs; tab++) {
			for (let index = 0; index < blocks; index++) {
				if (await store.getCurrent('token', {id: `tab-${tab}-${index}`})) found++;
			}
		}
		return {expected: tabs * blocks, found, missing: tabs * blocks - found};
	} finally {
		await store.close();
	}
}

/**
 * The reference store, run through the same workload in the same page.
 *
 * Not a substitute for the node-side comparison (which is what makes it a
 * CROSS-RUNTIME equality); it is here so that a difference can be attributed:
 * two backends disagreeing inside one engine is this store, while the tab
 * disagreeing with node on both backends is the workload.
 */
async function reference(timings: Timing[]): Promise<Record<string, unknown>> {
	const store: StateStore = new MemoryStateStore(processor.entities);
	await store.migrate();
	return {...(await timed('reference', timings, () => runWorkload(store)))};
}

const cut: CodeUnderTest = {
	name: '@etherfold/state-store-indexeddb',
	async run(ctx: RunContext): Promise<RunResult> {
		const timings: Timing[] = [];
		const errors: string[] = [];
		let results: Record<string, unknown> = {};

		try {
			if (ctx.phase === 'write') {
				results = await writePhase(ctx.params, timings);
			} else if (ctx.phase === 'read') {
				results = await readPhase(ctx.params, timings);
			} else {
				switch (ctx.params.case) {
					case 'conformance':
						results = await conformance(ctx.params, timings);
						break;
					case 'processor':
						results = {...(await sameProcessor(ctx.params, timings)), reference: await reference(timings)};
						break;
					case 'access-path':
						results = await accessPath(ctx.params);
						break;
					case 'multi-tab':
						results = await multiTab(ctx.params, timings);
						break;
					case 'multi-tab-audit':
						results = await multiTabAudit(ctx.params);
						break;
					default:
						throw new Error(`unknown case ${JSON.stringify(ctx.params.case)}`);
				}
			}
		} catch (error) {
			errors.push(`${(error as Error)?.stack ?? error}`);
		}

		return {results, timings, errors, env: captureEnv()};
	},
};

export default cut;
