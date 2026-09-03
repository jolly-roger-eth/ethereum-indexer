import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {EnvRecord} from '@etherfold/fetcher-host';
import {createNodeDB, startServer, type RunningServer} from '@etherfold/platform-nodejs';
import type {RunningFetcher} from '@etherfold/platform-nodejs-fetcher';
import {createQuerySurface, VersionedStateStore} from '@etherfold/state-store-sqlite';
import {afterEach, describe, expect, it} from 'vitest';
import {
	fetch as startFetch,
	index,
	run,
	serve,
	type RunningIndexer,
	type RunningReceiver,
	type StoreCursorReport,
} from '../src/index.js';
import type {Options} from '../src/types.js';
import {
	abi,
	ALICE,
	BOB,
	CAROL,
	entityModule,
	fakeChain,
	nftEntities,
	SOURCE,
	START_BLOCK,
	transfer,
	ZERO,
} from './utils/chain.js';

// ---------------------------------------------------------------------------------------------------
// THE SPLIT IS A DEPLOYMENT CHOICE, ASSERTED AT THE COMMANDS
// ---------------------------------------------------------------------------------------------------
// `packages/processor-sqlite/test/deployment-shapes.test.ts` already pins this
// equivalence at the COMPONENT level: it constructs the pieces and shows that
// one processor and one set of declarations land the same state whether the two
// ADR-0003 halves meet in one process or across a wire. That is the same shape
// this file extends, one level up, because the spec insists on it: "the existing
// proof of equivalence is a test that constructs the pieces; this must be the
// COMMAND".
//
// So the two runs below are two DEPLOYMENTS, entered the way an operator enters
// them:
//
//   combined   `etherfold run`  -- one process, the wire removed
//                                 (`createDirectIngestion`)
//   split      `etherfold fetch` -> real HTTP -> `etherfold index`, two
//                                 processes with a socket between them
//
// Everything else is held identical ON PURPOSE, because that is what makes the
// assertion mean anything: the same processor module, the same entity
// declarations, the same explicit source, the same stream config (nothing sets
// `STREAM_FINALITY`, so both halves resolve the same default and therefore the
// same wire identity), and the same fixture chain served to both, INCLUDING a
// reorg whose replacement branch carries FEWER events -- so a state that merely
// grew monotonically cannot pass.
//
// The transport is the only difference. If these two ever disagree, one of the
// two shapes is wrong, and that is the whole claim.
// ---------------------------------------------------------------------------------------------------

const TOKEN = 'a-shared-secret';

/**
 * What varies between deployments of one image, and nothing else.
 *
 * Bounded fetch ranges and short waits so several cycles happen quickly. No
 * `STREAM_FINALITY`: the sender, the receiver and the combined process must all
 * reach the same resolved `finality`, and the way to guarantee that is to let
 * every one of them take the same default rather than to set the same number
 * three times.
 */
const DEPLOYMENT: EnvRecord = {
	INDEXING_SOURCE: JSON.stringify(SOURCE),
	MAX_BLOCKS_PER_FETCH: '20',
	POLL_INTERVAL_MS: '5',
	CATCH_UP_DELAY_MS: '0',
	MIN_RETRY_DELAY_MS: '5',
};

// ---------------------------------------------------------------------------------------------------
// ONE FIXTURE CHAIN, WITH A REORG THAT TAKES EVENTS AWAY
// ---------------------------------------------------------------------------------------------------

/** Two mints low down, then two transfers high up, inside the window a reorg can reach. */
const BRANCH_A = [
	transfer(START_BLOCK + 10, '0xa10', ZERO, ALICE, 1n),
	transfer(START_BLOCK + 10, '0xa10', ZERO, BOB, 2n, 1),
	transfer(START_BLOCK + 90, '0xa90', ALICE, BOB, 1n),
	transfer(START_BLOCK + 90, '0xa90', BOB, CAROL, 2n, 1),
];
const TIP_A = START_BLOCK + 100;

/**
 * The same chain with a different block 90, carrying ONE event where the dead
 * branch carried two.
 *
 * That is the case a monotonic state cannot fake: the counter has to come DOWN
 * from 4 to 3, and tokens 1 and 2 have to go back to the owners the mints gave
 * them, on both deployment shapes.
 */
const BRANCH_B = [BRANCH_A[0]!, BRANCH_A[1]!, transfer(START_BLOCK + 90, '0xb90', ZERO, CAROL, 3n)];
const TIP_B = TIP_A + 1;

const CHAIN_STATES = [
	{logs: BRANCH_A, tip: TIP_A, transfers: 4},
	{logs: BRANCH_B, tip: TIP_B, transfers: 3},
] as const;

// ---------------------------------------------------------------------------------------------------

let combined: RunningIndexer | undefined;
let receiver: RunningReceiver | undefined;
let sender: RunningFetcher<typeof abi> | undefined;
let readTier: RunningServer | undefined;
let directory: string | undefined;

afterEach(async () => {
	await sender?.stop().catch(() => undefined);
	await combined?.stop().catch(() => undefined);
	await receiver?.stop().catch(() => undefined);
	await readTier?.close().catch(() => undefined);
	sender = combined = receiver = undefined;
	readTier = undefined;
	if (directory) rmSync(directory, {recursive: true, force: true});
	directory = undefined;
});

/** Poll something a running process publishes until it says what we are waiting for. */
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
	const deadline = Date.now() + 20_000;
	for (;;) {
		const value = await read();
		if (done(value)) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; last saw ${JSON.stringify(value)}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

type Status = {
	healthy: boolean;
	reorgs?: {absence: number; contradiction: number; last?: unknown};
	schema: {applied: boolean; version?: number; expected: number; matches?: boolean};
	cursor?: {reported: boolean; value?: StoreCursorReport};
};

async function statusOf(url: string): Promise<Status> {
	return (await (await globalThis.fetch(`${url}/status`)).json()) as Status;
}

async function cursorOf(url: string): Promise<StoreCursorReport | undefined> {
	const {cursor} = await statusOf(url);
	return cursor?.reported ? cursor.value : undefined;
}

/**
 * Everything a reader can ask, through the surface GENERATED from the entity
 * declarations, opened over one database URL.
 *
 * The declarations are the processor's own (`nftEntities`), which is the point:
 * a consumer names an entity and its declared columns, never a table and never a
 * column string, so this comparison is the one a real reader would make. Both
 * tiers are exercised -- the bounded seam reads every backend has (`getCurrent`)
 * and the SQL tier a server-side reader gets (`queryCurrent`, which is the only
 * way to ask for a whole entity) -- because the read tier this milestone ships
 * is a database connection and not an HTTP query route.
 */
async function readsOver(url: string): Promise<unknown> {
	const store = new VersionedStateStore(createNodeDB(url), nftEntities);
	const surface = createQuerySurface(store, nftEntities);
	return {
		nfts: await surface.nft.queryCurrent({orderBy: 'tokenID'}),
		counters: await surface.counter.queryCurrent({orderBy: 'name'}),
		byId: {
			1: await surface.nft.getCurrent({tokenID: tokenID(1n)}),
			2: await surface.nft.getCurrent({tokenID: tokenID(2n)}),
			3: await surface.nft.getCurrent({tokenID: tokenID(3n)}),
			transfers: await surface.counter.getCurrent({name: 'transfers'}),
		},
	};
}

const tokenID = (id: bigint) => id.toString().padStart(78, '0');

/** `etherfold run`: the combined deployment, folding into a database it owns. */
async function startCombined(db: string, chain: ReturnType<typeof fakeChain>): Promise<RunningIndexer> {
	return run(
		{processor: './nfts.js', store: 'sqlite', db, nodeUrl: 'http://localhost:0', port: '0'},
		{
			importModule: async () => entityModule,
			provider: chain.provider,
			// a follower waits between cycles, and a test must not
			sleep: async () => {
				await new Promise((resolve) => setTimeout(resolve, 1));
			},
			handleSignals: false,
			log: () => {},
			env: DEPLOYMENT,
		},
	);
}

/** `etherfold index`: the receiving half, owning the database the split writes. */
async function startReceiver(db: string): Promise<RunningReceiver> {
	return index(
		{processor: './nfts.js', store: 'sqlite', db, port: '0', ingestToken: TOKEN},
		{
			importModule: async () => entityModule,
			handleSignals: false,
			log: () => {},
			env: DEPLOYMENT,
		},
	);
}

/** `etherfold fetch`: the chain-facing half, pushing over a real socket at a real port. */
async function startSender(endpoint: string, chain: ReturnType<typeof fakeChain>): Promise<RunningFetcher<typeof abi>> {
	const options: Options = {nodeUrl: 'http://localhost:0', ingestEndpoint: endpoint, ingestToken: TOKEN};
	return startFetch<typeof abi>(options, {provider: chain.provider, handleSignals: false, env: DEPLOYMENT});
}

// ---------------------------------------------------------------------------------------------------

describe('`run` and `fetch` plus `index` land on IDENTICAL state', () => {
	it('reaches the same state and the same cursor from the same chain, reorg included', async () => {
		directory = mkdtempSync(join(tmpdir(), 'etherfold-equivalence-'));
		const combinedDB = `file:${join(directory, 'combined.db')}`;
		const splitDB = `file:${join(directory, 'split.db')}`;

		const combinedChain = fakeChain();
		const splitChain = fakeChain();

		combined = await startCombined(combinedDB, combinedChain);
		receiver = await startReceiver(splitDB);
		sender = await startSender(receiver.url, splitChain);

		// the same chain states, in the same order, to both deployments
		for (const state of CHAIN_STATES) {
			combinedChain.serve([...state.logs], state.tip);
			splitChain.serve([...state.logs], state.tip);

			await until(
				() => cursorOf(combined!.url),
				(cursor) => cursor?.lastToBlock === state.tip,
				`the combined deployment to reach block ${state.tip}`,
			);
			await until(
				() => cursorOf(receiver!.url),
				(cursor) => cursor?.lastToBlock === state.tip,
				`the split deployment to reach block ${state.tip}`,
			);
		}

		const viaOneProcess = await readsOver(combinedDB);
		const viaTheWire = await readsOver(splitDB);

		expect(viaTheWire).toEqual(viaOneProcess);
		// ...and it is not two empty states, nor two states that only ever grew: the
		// replacement branch carried ONE event where the dead one carried two, so the
		// counter came down and the two mints are back where the mints put them
		expect(viaOneProcess).toMatchObject({
			byId: {
				1: {owner: ALICE.toLowerCase()},
				2: {owner: BOB.toLowerCase()},
				3: {owner: CAROL.toLowerCase()},
				transfers: {value: 3},
			},
		});

		// the CURSOR is part of the equivalence, and it is asserted between the two
		// FOLDING processes -- never against the read tier, which owns no store and is
		// given no reporter.
		//
		// On WHERE THE FOLD HAS GOT TO, which is what the report exists to answer: is
		// it moving (`lastToBlock`) and how far behind is it (`latestBlock`). Not on
		// `lastFromBlock`, which is the START of whichever range happened to be last:
		// that depends on how many cycles each side ran while the chain sat at a tip,
		// and a socket makes a cycle take longer than a function call. It is an
		// artefact of timing rather than a property of the deployment shape, and
		// pinning it would make this assertion fail for a reason it does not care
		// about.
		const viaWire = await cursorOf(receiver.url);
		const inOneProcess = await cursorOf(combined.url);
		expect(viaWire).toBeDefined();
		expect(viaWire!.lastToBlock).toBe(inOneProcess!.lastToBlock);
		expect(viaWire!.latestBlock).toBe(inOneProcess!.latestBlock);
		expect(viaWire!.lastToBlock).toBe(TIP_B);

		// the reorg was concluded on both sides from raw ranges alone, and on the
		// split side it was concluded by the RECEIVER, which never saw a chain
		expect((await statusOf(receiver.url)).reorgs).toMatchObject({contradiction: 1, absence: 0});
	});
});

// ---------------------------------------------------------------------------------------------------
// A READ TIER OVER THE SAME DATABASE, BOUNDED TO THE SURFACES THAT EXIST
// ---------------------------------------------------------------------------------------------------
// "The same reads" is bounded by what this milestone SHIPS. The GraphQL layer is
// deliberately not in it and `/status` is the whole HTTP query surface, so
// "reads" means the surface GENERATED from the entity declarations, opened over
// the database `serve` was pointed at -- and adding an HTTP query route to make
// the sentence literal would be shipping the deferred milestone (a general
// SQL-over-HTTP surface is rejected outright).
//
// Two things about `/status` are asserted here and one is deliberately NOT:
//
//   asserted   the SCHEMA version, which the server reads out of the database
//              itself, is the same on the read tier as on `run`.
//   asserted   the REORG COUNTERS the read tier reports are the ones its
//              database holds -- the same numbers the WRITER of that database
//              reports. `run`'s counters are not the comparison object: the
//              counter is written by the HTTP ingest route (`recordReorg`), and
//              a combined process folds through the direct in-process wire and
//              never touches that route, so it counts none. That gap is real
//              and is recorded in
//              `work/notes/observations/a-run-process-counts-no-reorgs-on-status.md`;
//              it is not this task's to close, and asserting equality here
//              would pin a number that means "nobody counted".
//   NOT        the CURSOR. It reaches `/status` only through an INJECTED
//              reporter, and a read tier owns no store and is given none, so
//              `serve` reports no cursor. That is correct rather than a bug, and
//              the assertion below pins it as such.
// ---------------------------------------------------------------------------------------------------

describe('`index` plus `serve` against ONE database answer what `run` answers', () => {
	afterEach(() => {
		delete process.env.INGEST_TOKEN;
	});

	it('answers the same reads, agrees on the schema, and reports no cursor', async () => {
		// A read tier's token can only come from the ambient environment:
		// `--ingest-token` is refused by `serve`, which receives no pushes. It is set
		// so the LAST assertion can be made at all -- the token guard sits on the PATH,
		// ahead of the capability lookup, so 501 is reachable only by an AUTHENTICATED
		// caller and an anonymous one gets 401 whether or not a processor is hosted.
		// That ordering is not reordered to make a test simpler: it is what stops an
		// anonymous caller probing which servers hold a processor.
		process.env.INGEST_TOKEN = TOKEN;
		directory = mkdtempSync(join(tmpdir(), 'etherfold-read-tier-'));
		const combinedDB = `file:${join(directory, 'combined.db')}`;
		const splitDB = `file:${join(directory, 'split.db')}`;

		const combinedChain = fakeChain();
		const splitChain = fakeChain();
		combined = await startCombined(combinedDB, combinedChain);
		receiver = await startReceiver(splitDB);
		sender = await startSender(receiver.url, splitChain);

		for (const state of CHAIN_STATES) {
			combinedChain.serve([...state.logs], state.tip);
			splitChain.serve([...state.logs], state.tip);
			await until(
				() => cursorOf(combined!.url),
				(cursor) => cursor?.lastToBlock === state.tip,
				`the combined deployment to reach block ${state.tip}`,
			);
			await until(
				() => cursorOf(receiver!.url),
				(cursor) => cursor?.lastToBlock === state.tip,
				`the split deployment to reach block ${state.tip}`,
			);
		}

		// the READ TIER: a second process, holding no processor, over the database the
		// receiver wrote. It resolves its own database and starts the real Node
		// adapter; only the handle it hands back is captured, so the test can stop it.
		await serve(
			{db: splitDB, port: '0'},
			{
				env: {},
				log: () => {},
				startServer: async (options) => (readTier = await startServer(options)),
			},
		);
		const served = readTier!;

		// the reads: the same surface, generated from the same declarations, over the
		// database `serve` was pointed at
		expect(await readsOver(splitDB)).toEqual(await readsOver(combinedDB));

		const readTierStatus = await statusOf(served.url);
		const combinedStatus = await statusOf(combined.url);
		const writerStatus = await statusOf(receiver.url);

		// the schema version is derived from the DATABASE, so a read tier and a
		// combined process agree on it
		expect(readTierStatus.schema).toEqual(combinedStatus.schema);
		expect(readTierStatus.healthy).toBe(true);

		// so are the reorg counters, which the read tier reads out of the database its
		// writer counted them into
		expect(readTierStatus.reorgs).toEqual(writerStatus.reorgs);
		expect(readTierStatus.reorgs).toMatchObject({contradiction: 1, absence: 0});

		// and the cursor is absent, because a read tier owns no store and is given no
		// reporter. `run` reports one; this is the honest size of the read tier today
		expect(readTierStatus.cursor).toBeUndefined();
		expect(combinedStatus.cursor).toMatchObject({reported: true});

		// the read tier writes nothing: the write path is a CAPABILITY it does not
		// have rather than a route table it lacks
		const pushed = await globalThis.fetch(`${served.url}/ingest/expected-from-block`, {
			method: 'POST',
			headers: {Authorization: `Bearer ${TOKEN}`},
		});
		expect(pushed.status).toBe(501);
	});
});
