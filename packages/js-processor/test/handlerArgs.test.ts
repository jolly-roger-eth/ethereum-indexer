import {describe, expect, it} from 'vitest';
import type {Abi} from 'abitype';
import type {ExtractAbiEvent, LastSync, LogEvent} from '@etherfold/core';
import {fromJSProcessor, type JSProcessor} from '../src/processor/utils.js';
import type {InputValues} from '../src/processor/types.js';

/**
 * ONE handler name can cover TWO wire events, and the type must say so.
 *
 * An upgraded contract can emit `Transfer(address,address,uint256)` before the
 * upgrade block and `Transfer(address,address,uint256,bytes)` after it. The two
 * have different topic0s and are distinguishable on the wire, but they share a
 * NAME, so `ExtractAbiEventNames` collapses them and the author writes ONE
 * `onTransfer`.
 *
 * `InputValues` used to map over the two input lists with `T` taken WHOLE, which
 * MERGED them into `{from, to, id, memo}` with `memo` REQUIRED. A v1 log then
 * handed the author `undefined` through a type promising a value. It now
 * DISTRIBUTES, so `args` is a union the author must narrow.
 *
 * **`pnpm typecheck` is what runs most of this file.** Each `@ts-expect-error`
 * FAILS the typecheck if the line it guards starts compiling, which is the only
 * way to assert that something is NOT accepted; vitest strips types with esbuild
 * without checking them. What vitest runs is the run-time half: that the
 * narrowing the types now force is the branch a v1 payload actually takes.
 */

/** Type identity, not assignability: a union and a merge are assignable in one direction. */
type IsExactly<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** A contract upgraded mid-life: `Transfer` gained a `memo`, so ONE name covers TWO events. */
const upgradedAbi = [
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
	{
		type: 'event',
		name: 'Transfer',
		anonymous: false,
		inputs: [
			{indexed: true, name: 'from', type: 'address'},
			{indexed: true, name: 'to', type: 'address'},
			{indexed: false, name: 'id', type: 'uint256'},
			{indexed: false, name: 'memo', type: 'bytes'},
		],
	},
] as const satisfies Abi;
type UpgradedABI = typeof upgradedAbi;

/** The ordinary case: one version, no upgrade, and it must cost nothing. */
const singleVersionAbi = [
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
type SingleVersionABI = typeof singleVersionAbi;

type State = {transfers: number; memoed: number};

/**
 * The args of a single-version event are the SAME object type they always were,
 * spelled out rather than derived, so a widening (to `any`, to an optional, to a
 * union with `never`) fails here rather than passing silently downstream.
 */
const singleVersionArgsAreUnchanged: IsExactly<
	InputValues<ExtractAbiEvent<SingleVersionABI, 'Transfer'>>,
	{from: `0x${string}`; to: `0x${string}`; id: bigint}
> = true;

/** Two same-named events give a UNION of the two input lists, never their merge. */
const upgradedArgsAreAUnion: IsExactly<
	InputValues<ExtractAbiEvent<UpgradedABI, 'Transfer'>>,
	| {from: `0x${string}`; to: `0x${string}`; id: bigint}
	| {from: `0x${string}`; to: `0x${string}`; id: bigint; memo: `0x${string}`}
> = true;

const upgraded: JSProcessor<UpgradedABI, State> = {
	version: '1.0.0',
	construct() {
		return {transfers: 0, memoed: 0};
	},
	onTransfer(state, event) {
		// Every version carries these, so they read without narrowing.
		const to: `0x${string}` = event.args.to;
		const id: bigint = event.args.id;
		if (to && id >= 0n) state.transfers++;

		// @ts-expect-error `memo` is in only ONE of the two `Transfer`s, so an un-narrowed read is a lie: a pre-upgrade log has no memo
		const lie: `0x${string}` = event.args.memo;

		if ('memo' in event.args) {
			// narrowed to the v2 shape: the version-specific field AND the shared ones
			const memo: `0x${string}` = event.args.memo;
			const stillShared: bigint = event.args.id;
			if (memo.length > 2 && stillShared >= 0n) state.memoed++;
		}
	},
};

/**
 * The common case, written exactly as `reorg.test.ts` writes it and compiling
 * exactly as it did. This is the criterion that stops the fix costing the
 * single-version author anything: no narrowing, no cast, no widened field.
 */
const ordinary: JSProcessor<SingleVersionABI, State> = {
	version: '1.0.0',
	construct() {
		return {transfers: 0, memoed: 0};
	},
	onTransfer(state, event) {
		const to: `0x${string}` = event.args.to;
		const id: bigint = event.args.id;
		const from: `0x${string}` = event.args.from;
		if (to && from && id >= 0n) state.transfers++;

		// @ts-expect-error and the args are still a CLOSED object: a field no version declares is refused
		event.args.memo;
	},
};

let logCounter = 0;
function transfer(blockNumber: number, blockHash: string, args: Record<string, unknown>): LogEvent<UpgradedABI> {
	logCounter++;
	return {
		blockNumber,
		blockHash: blockHash as `0x${string}`,
		transactionIndex: 0,
		removed: false,
		address: '0x0000000000000000000000000000000000000000',
		data: '0x',
		topics: [],
		transactionHash: `0x${logCounter.toString(16).padStart(64, '0')}` as `0x${string}`,
		logIndex: 0,
		extra: undefined,
		eventName: 'Transfer',
		args,
	} as unknown as LogEvent<UpgradedABI>;
}

const CONTEXT = {source: [{startBlock: 0, hash: 'h'}], config: 'cfg', processor: 'proc'};
function lastSync(over: Partial<LastSync<UpgradedABI>> = {}): LastSync<UpgradedABI> {
	return {
		context: CONTEXT,
		latestBlock: 0,
		lastFromBlock: 0,
		lastToBlock: 0,
		unconfirmedBlocks: [],
		...over,
	};
}

describe('a handler covering two versions of one event', () => {
	it('takes the un-memoed branch for a pre-upgrade log and the memoed one after', async () => {
		const p = fromJSProcessor(upgraded)();
		await p.load(
			{chainId: '1', contracts: [{abi: upgradedAbi, address: '0x0000000000000000000000000000000000000000'}]} as any,
			{
				finality: 12,
			},
		);

		const state = await p.process(
			[
				transfer(100, '0xA', {from: '0x0', to: '0xalice', id: 1n}),
				transfer(101, '0xB', {from: '0xalice', to: '0xbob', id: 1n, memo: '0xdeadbeef'}),
			],
			lastSync({latestBlock: 101, lastToBlock: 101}),
		);

		expect(state).toEqual({transfers: 2, memoed: 1});
	});

	it('holds the two type claims the compiler checked', () => {
		// The value of these constants is uninteresting; that they were ASSIGNABLE
		// at all is the assertion, and `pnpm typecheck` is what made it.
		expect([singleVersionArgsAreUnchanged, upgradedArgsAreAUnion]).toEqual([true, true]);
		expect(typeof ordinary.onTransfer).toBe('function');
	});
});
