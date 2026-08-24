import type {Abi, IndexingSource, LastSync} from '@etherfold/core';
import {EntityEventProcessor, type EntityProcessor, type EntityStateView} from '@etherfold/processor-entities';
import type {StateStore} from '@etherfold/state-store';
import {createIndexerState} from '../src/index.js';

/**
 * The subject both runners drive: one entity processor, one captured stream, one
 * hook.
 *
 * It lives here rather than in `test/` for the same reason
 * `@etherfold/state-store-indexeddb` puts its workload beside its Playwright
 * specs: the browser specs bundle THIS module into a real page, and the node
 * tests import the very same object. An equality between the two runtimes is
 * only worth something if neither side got its own copy of the processor, its
 * own copy of the chain, or its own copy of the expected answer.
 *
 * The processor mirrors the fixture every other reorg test in this repository
 * quotes (`@etherfold/js-processor`'s `reorg.test.ts`, and its entity port in
 * `@etherfold/processor-sqlite`): a `token` owner per id, and a `counter` row
 * counting transfers. The counter is not decoration -- it is the value that must
 * come DOWN when a block is reorged out, which is the canonical bug the whole
 * storage seam exists to make impossible.
 */

export const abi = [
	{
		type: 'event',
		name: 'Transfer',
		anonymous: false,
		inputs: [
			{indexed: true, name: 'from', type: 'address'},
			{indexed: true, name: 'to', type: 'address'},
			{indexed: false, name: 'id', type: 'uint256'},
		],
	},
] as const satisfies Abi;

export type TestABI = typeof abi;

/**
 * The processor an application author writes: declarations and handlers, naming
 * no backend.
 *
 * Every store below runs THIS object. Nothing in it says IndexedDB, patches or
 * SQLite, which is the claim the tests around it are checking.
 */
export const processor: EntityProcessor<TestABI> = {
	version: '1.0.0',
	entities: [
		{name: 'token', id: ['id'], fields: {owner: 'text'}},
		{name: 'counter', id: ['name'], fields: {value: 'integer'}},
	],
	async onTransfer(state, event) {
		state.set('token', {id: event.args.id.toString()}, {owner: event.args.to});
		const counter = await state.get<{value: number}>('counter', {name: 'transfers'});
		state.set('counter', {name: 'transfers'}, {value: (counter?.value ?? 0) + 1});
	},
};

/**
 * Digits-only addresses, deliberately.
 *
 * The decoder hands a handler an EIP-55 checksummed address, so an address with
 * hex letters in it would be stored in a casing no assertion here could quote
 * without also encoding viem's checksum. An address with no letters is
 * checksum-invariant.
 */
const CONTRACT = '0x0000000000000000000000000000000000000099' as const;
export const ALICE = '0x0000000000000000000000000000000000000011';
export const BOB = '0x0000000000000000000000000000000000000022';
export const CAROL = '0x0000000000000000000000000000000000000033';
export const DAN = '0x0000000000000000000000000000000000000044';
export const ERIN = '0x0000000000000000000000000000000000000055';
const ZERO = '0x0000000000000000000000000000000000000000';

export const START_BLOCK = 100;

export const SOURCE: IndexingSource<TestABI> = {
	chainId: '1',
	contracts: [{abi, address: CONTRACT, startBlock: START_BLOCK}],
};

/** Small on purpose: the reorg below has to fall INSIDE the unconfirmed window. */
export const FINALITY = 3;

/** `Transfer(address,address,uint256)`, which is what this ABI's event hashes to. */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as const;

/** The raw shape a node returns, which is what a captured stream is captured AS. */
export type RawLog = {
	blockNumber: string;
	blockHash: string;
	transactionIndex: string;
	removed: boolean;
	address: string;
	data: string;
	topics: string[];
	transactionHash: string;
	logIndex: string;
	blockTimestamp: string;
};

function hex(value: number): string {
	return `0x${value.toString(16)}`;
}

function addressTopic(address: string): string {
	return `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;
}

/** Deterministic and monotonic, so the recorded time axis is assertable. */
export function timestampOf(blockNumber: number): number {
	return 1_700_000_000 + blockNumber * 12;
}

let logCounter = 0;

function transferLog(
	blockNumber: number,
	blockHash: string,
	args: {from: string; to: string; id: bigint},
	logIndex = 0,
): RawLog {
	logCounter++;
	return {
		blockNumber: hex(blockNumber),
		blockHash,
		transactionIndex: '0x0',
		removed: false,
		address: CONTRACT,
		data: `0x${args.id.toString(16).padStart(64, '0')}`,
		topics: [TRANSFER_TOPIC, addressTopic(args.from), addressTopic(args.to)],
		transactionHash: `0x${logCounter.toString(16).padStart(64, '0')}`,
		logIndex: hex(logIndex),
		blockTimestamp: hex(timestampOf(blockNumber)),
	};
}

/**
 * The captured stream: blocks 100, 102 and 104 carry logs, the tip is 105.
 *
 * Fixed bytes rather than a live chain, so that a run in node and a run in
 * Chromium are comparable at all. Block 100 is outside the finality window at
 * that tip, so it is CONFIRMED by the time the reorg lands and cannot be part of
 * what is retracted.
 */
export const BRANCH_A: readonly RawLog[] = [
	transferLog(100, '0xa100', {from: ZERO, to: ALICE, id: 1n}, 0),
	transferLog(100, '0xa100', {from: ZERO, to: BOB, id: 2n}, 1),
	transferLog(102, '0xa102', {from: ALICE, to: BOB, id: 1n}),
	transferLog(104, '0xa104', {from: ZERO, to: DAN, id: 3n}, 0),
	transferLog(104, '0xa104', {from: BOB, to: ERIN, id: 2n}, 1),
];
export const BRANCH_A_TIP = 105;

/**
 * The same chain after a reorg at 104: same 100 and 102, a DIFFERENT 104.
 *
 * The replacement carries FEWER events than what it replaces, which is the case
 * that matters: the counter must come DOWN (5 -> 4), token 3 must vanish
 * entirely, and token 2 -- which the replacement never mentions -- must go back
 * to the owner block 100 gave it.
 */
export const BRANCH_B: readonly RawLog[] = [
	BRANCH_A[0],
	BRANCH_A[1],
	BRANCH_A[2],
	transferLog(104, '0xb104', {from: ZERO, to: CAROL, id: 4n}),
];
export const BRANCH_B_TIP = 106;

/** The state branch A produces, as the assertions quote it. */
export const EXPECTED_A = {
	owners: {'1': BOB, '2': ERIN, '3': DAN, '4': undefined},
	transfers: 5,
};

/** The state branch B produces, once the reorg has been reverted and replaced. */
export const EXPECTED_B = {
	owners: {'1': BOB, '2': BOB, '3': undefined, '4': CAROL},
	transfers: 4,
};

/** One `eth_getLogs` call, as the fake chain saw it. */
export type FetchedRange = {from: number; to: number};

/**
 * A node that serves ONE branch at a time and records what it was asked for.
 *
 * The recording is the point on the resume path: "did this tab re-index from the
 * start block" is a question about the RANGES a reload asks for, and nothing in
 * the resulting state can answer it (re-indexing lands on the same rows).
 */
export function fakeChain(branch: readonly RawLog[] = BRANCH_A, latestBlock: number = BRANCH_A_TIP) {
	const ranges: FetchedRange[] = [];
	let served: readonly RawLog[] = branch;
	let tip = latestBlock;
	return {
		ranges,
		serve(logs: readonly RawLog[], newTip: number) {
			served = logs;
			tip = newTip;
		},
		provider: {
			async request(args: {method: string; params?: any}): Promise<any> {
				switch (args.method) {
					case 'eth_chainId':
						return hex(Number(SOURCE.chainId));
					case 'eth_blockNumber':
						return hex(tip);
					case 'eth_getLogs': {
						const from = parseInt(args.params[0].fromBlock.slice(2), 16);
						const to = parseInt(args.params[0].toBlock.slice(2), 16);
						ranges.push({from, to});
						return served.filter((log) => {
							const blockNumber = parseInt(log.blockNumber.slice(2), 16);
							return blockNumber >= from && blockNumber <= to;
						});
					}
				}
				throw new Error(`unexpected method ${args.method}`);
			},
		} as any,
	};
}

/** The state as the assertions quote it, read back through the seam-tier handle. */
export async function readState(view: EntityStateView): Promise<{
	owners: Record<string, string | undefined>;
	transfers: number;
}> {
	const owners: Record<string, string | undefined> = {};
	for (const id of ['1', '2', '3', '4']) {
		owners[id] = (await view.getCurrent<{owner: string}>('token', {id}))?.owner;
	}
	return {
		owners,
		transfers: (await view.getCurrent<{value: number}>('counter', {name: 'transfers'}))?.value ?? 0,
	};
}

/**
 * The hook, wired to a store, exactly as an application wires it.
 *
 * Two lines an application author writes, and the reason this whole task exists:
 * the store is the deployment's choice, the processor above is untouched, and
 * `{kind: 'entities'}` is the caller SAYING which kind of processor it is
 * handing over rather than the hook guessing from the fields it finds.
 */
export function indexerFor(store: StateStore) {
	return createIndexerState<TestABI, EntityStateView>({
		kind: 'entities',
		processor: new EntityEventProcessor<TestABI>(store, processor),
	});
}

type IndexerState = ReturnType<typeof indexerFor>;

/**
 * Drive the hook to the tip, one `indexMore` at a time.
 *
 * `indexToLatest` is not used here on purpose: it swallows a failure and retries
 * on a timer forever, which in a test turns a broken wiring into a hang instead
 * of a red line.
 */
export async function indexToTip(indexer: IndexerState, maxRounds = 20): Promise<LastSync<TestABI>> {
	let lastSync = await indexer.indexMore();
	let rounds = 0;
	while (lastSync.lastToBlock < lastSync.latestBlock && rounds++ < maxRounds) {
		lastSync = await indexer.indexMore();
	}
	return lastSync;
}

/**
 * One whole run: open the hook over `store`, index the captured stream, read the
 * state back.
 *
 * `chain` is passed in so a caller can keep the SAME node across two runs, which
 * is what makes the reload case a reload rather than a fresh chain.
 */
export async function runWorkload(
	store: StateStore,
	chain: ReturnType<typeof fakeChain> = fakeChain(),
): Promise<{
	state: Awaited<ReturnType<typeof readState>>;
	lastSync: LastSync<TestABI>;
	ranges: FetchedRange[];
	indexer: IndexerState;
}> {
	const indexer = indexerFor(store);
	await indexer.init({provider: chain.provider, source: SOURCE, config: {stream: {finality: FINALITY}}});
	const lastSync = await indexToTip(indexer);
	const state = await readState(indexer.state.$state);
	indexer.dispose();
	return {state, lastSync, ranges: chain.ranges, indexer};
}
