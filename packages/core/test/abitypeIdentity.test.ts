import {createRequire} from 'node:module';
import {parseAbiItem} from 'viem';
import type {
	Abi as ViemAbi,
	AbiEvent as ViemAbiEvent,
	AbiParameter as ViemAbiParameter,
	AbiParameterToPrimitiveType as ViemAbiParameterToPrimitiveType,
} from 'viem';
import {describe, expect, it} from 'vitest';
import type {Abi, AbiEvent, AbiParameter, AbiParameterToPrimitiveType, ExtractAbiEvent} from '../src/index.js';

/**
 * ONE `abitype` resolves in this workspace, and these assertions are what says so.
 *
 * `@etherfold/core` re-exports abitype's types (`Abi`, `AbiEvent`,
 * `ExtractAbiEvent`, ...) as part of its own public surface while also depending
 * on `viem`, which pins its own exact `abitype`. When the two ranges disagree,
 * pnpm installs BOTH copies, and structurally identical types from the two are
 * no longer interchangeable at every site: the register-sensitive types resolve
 * against whichever copy a consumer's module augmentation reached. The damage
 * lands in a CONSUMER's build, as "two different types with this name exist, but
 * they are unrelated", naming files inside `node_modules` and nothing about the
 * cause. Root `package.json` therefore carries a `pnpm.overrides` pin for
 * `abitype`, chosen UP (to what `core` declares) rather than down, so viem gets
 * the newer patch instead of `core` getting an older one.
 *
 * `pnpm typecheck` is what RUNS the type-level assertions below: they are
 * compile-time facts, and the `= true` initialisers reject the day the two
 * sides stop being interchangeable.
 *
 * They are not the whole guard, and saying why matters. abitype's types are
 * STRUCTURAL, so two copies of the SAME version stay mutually assignable and
 * the aliases below stay `true`: what they catch is the copies DIVERGING (a
 * later abitype reshaping `Abi`, or a `Register` augmentation that merged into
 * one copy only), not the second copy existing. The cause itself is caught by
 * the last case, which resolves `abitype` from this package and from inside
 * viem and compares what it got.
 */

type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// The plain shapes: a viem-derived ABI is a core-derived ABI and back.
const abiIsOneType: MutuallyAssignable<ViemAbi, Abi> = true;
const abiEventIsOneType: MutuallyAssignable<ViemAbiEvent, AbiEvent> = true;
const abiParameterIsOneType: MutuallyAssignable<ViemAbiParameter, AbiParameter> = true;

// The REGISTER-sensitive one, which is where a second copy actually bites: what
// a `uint256` decodes to is read off abitype's `Register` interface, and an
// augmentation merges into one copy of that interface, not both.
const uint256IsOneType: MutuallyAssignable<
	ViemAbiParameterToPrimitiveType<{type: 'uint256'}>,
	AbiParameterToPrimitiveType<{type: 'uint256'}>
> = true;

const erc20Transfer = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

// A viem-derived VALUE landing in a core-typed slot, which is the shape a
// consumer writes: viem parses the ABI, `@etherfold/core` indexes against it.
const transferEvent: AbiEvent = erc20Transfer;

const abi = [erc20Transfer] as const satisfies ViemAbi;
type Transfer = ExtractAbiEvent<typeof abi, 'Transfer'>;
const valueIsBigInt: MutuallyAssignable<AbiParameterToPrimitiveType<Transfer['inputs'][2]>, bigint> = true;

describe('abitype resolves to one copy across core and viem', () => {
	it('keeps viem-derived and core-derived ABI types mutually assignable', () => {
		expect([abiIsOneType, abiEventIsOneType, abiParameterIsOneType, uint256IsOneType, valueIsBigInt]).not.toContain(
			false,
		);
	});

	it('lets a viem-parsed event be read as the ABI event core publishes', () => {
		expect(transferEvent).toMatchObject({type: 'event', name: 'Transfer'});
	});

	it('resolves the same abitype from this package and from inside viem', () => {
		// Resolution rather than a scan of `node_modules/.pnpm`: it answers the
		// question actually at stake (which copy does each importer get?) and it
		// keeps answering it under a different linker or a hoisted tree.
		const fromCore = createRequire(import.meta.url);
		const fromViem = createRequire(fromCore.resolve('viem'));
		const version = (require_: NodeJS.Require) => (require_('abitype/package.json') as {version: string}).version;
		expect(version(fromViem)).toBe(version(fromCore));
	});
});
