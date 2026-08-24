/**
 * A SYNTHETIC stratagems event stream, at any size, deterministic from a seed.
 *
 * WHY THIS EXISTS, and what it is not. The captured Base stream is REAL and it
 * is what the port's equality is proved on, but it is also 42 events in 9
 * blocks: enough to prove the port right, nowhere near enough to find a
 * crossover between two storage engines. So the sweep needs a bigger workload,
 * and there are only two honest ways to get one: index a busier chain, or
 * generate more events of the same SHAPE.
 *
 * What is real here and what is invented:
 *   - REAL: the event shapes (the ABI's own argument types), the handlers, the
 *     whole `StratagemsContract` traversal, and therefore every mutation that
 *     comes out. The rows a backend stores are exactly what the real processor
 *     computes.
 *   - INVENTED: which player moved where, and when. The distribution of play is
 *     a guess, so any conclusion that depends on the exact ratio of cell writes
 *     to placement writes inherits that guess. A conclusion about ORDERS OF
 *     MAGNITUDE does not.
 *
 * Determinism matters as much as realism: every candidate backend must replay
 * the same bytes, so the generator is seeded and pure.
 */

/** mulberry32: small, fast, seeded, and the same on every engine. */
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function xyToBigIntID(x: number, y: number): bigint {
	return (x < 0 ? 2n ** 32n + BigInt(x) : BigInt(x)) + ((y < 0 ? 2n ** 32n + BigInt(y) : BigInt(y)) << 32n);
}

function address(n: number): `0x${string}` {
	return `0x${n.toString(16).padStart(40, '0')}` as `0x${string}`;
}

function bytes24(n: number): `0x${string}` {
	return `0x${n.toString(16).padStart(48, '0')}` as `0x${string}`;
}

const STRATAGEMS = '0xb99d938a722df8984722ab38732533130b4f3ec4';
const GEMS_GENERATOR = '0xbe2f7c303b53f16f447fd82bf549e65185bf3477';

export type WorkloadSpec = {
	seed?: number;
	/** How many epochs of play. Above 7 the placement window starts evicting, which is the case worth exercising. */
	epochs: number;
	playersPerEpoch: number;
	movesPerPlayer: number;
	/** Live cells are bounded by the grid, so this is what really sets dataset size. */
	gridSize: number;
	/** Emit the three reward events. They do not exist on Base; see packages/conformance-workload-stratagems/vendor/stratagems/README.md. */
	includeRewards?: boolean;
	/** Emit `ForceSimpleCells`, which the Base deployment never emitted either. */
	includeForceCells?: boolean;
	startBlock?: number;
	/** Events per block. Real blocks held up to 20; one is not representative either way. */
	eventsPerBlock?: number;
};

export type GeneratedBlock = {
	number: number;
	hash: string;
	timestamp: number;
	events: any[];
};

export function generateEventStream(spec: WorkloadSpec): GeneratedBlock[] {
	const random = rng(spec.seed ?? 1);
	const startBlock = spec.startBlock ?? 12_000_000;
	const eventsPerBlock = spec.eventsPerBlock ?? 8;
	const events: any[] = [];

	const pick = (max: number) => Math.floor(random() * max);
	const position = () => xyToBigIntID(pick(spec.gridSize) - (spec.gridSize >> 1), pick(spec.gridSize) - (spec.gridSize >> 1));

	for (let e = 0; e < spec.epochs; e++) {
		const epoch = 20000 + e;
		for (let p = 0; p < spec.playersPerEpoch; p++) {
			const player = address(1000 + p);
			events.push({
				eventName: 'CommitmentMade',
				address: STRATAGEMS,
				args: {player, epoch, commitmentHash: bytes24(e * 1000 + p)},
			});
		}
		for (let p = 0; p < spec.playersPerEpoch; p++) {
			const player = address(1000 + p);
			const moves = [];
			for (let m = 0; m < spec.movesPerPlayer; m++) {
				moves.push({position: position(), color: 1 + pick(5)});
			}
			events.push({
				eventName: 'CommitmentRevealed',
				address: STRATAGEMS,
				args: {
					player,
					epoch,
					commitmentHash: bytes24(e * 1000 + p),
					moves,
					furtherMoves: bytes24(0),
					newReserveAmount: 10n ** 18n,
				},
			});
		}

		// A player who committed and never revealed: the void/cancel path.
		if (spec.playersPerEpoch > 1) {
			const stray = address(1000 + spec.playersPerEpoch);
			events.push({
				eventName: 'CommitmentMade',
				address: STRATAGEMS,
				args: {player: stray, epoch, commitmentHash: bytes24(e)},
			});
			events.push({
				eventName: e % 2 === 0 ? 'CommitmentVoid' : 'CommitmentCancelled',
				address: STRATAGEMS,
				args: {player: stray, epoch, ...(e % 2 === 0 ? {amountBurnt: 0n} : {})},
			});
		}

		// Pokes: the read-modify-write path over cells nobody moved on this epoch.
		const pokes = [];
		for (let i = 0; i < Math.max(1, spec.movesPerPlayer >> 1); i++) pokes.push(position());
		events.push({eventName: 'MultiPoke', address: STRATAGEMS, args: {epoch, positions: pokes}});
		events.push({eventName: 'SinglePoke', address: STRATAGEMS, args: {epoch, position: position()}});

		if (spec.includeForceCells && e === 0) {
			const cells = [];
			for (let i = 0; i < 4; i++) {
				cells.push({position: position(), owner: address(2000 + i), color: 1 + pick(5), life: 2, stake: 1});
			}
			events.push({eventName: 'ForceSimpleCells', address: STRATAGEMS, args: {epoch, cells}});
		}

		if (spec.includeRewards) {
			const account = address(1000 + pick(Math.max(1, spec.playersPerEpoch)));
			events.push({
				eventName: 'AccounFixedRewardUpdated',
				address: GEMS_GENERATOR,
				args: {account, fixedRateStatus: {toWithdraw: BigInt(e) * 10n ** 15n, lastTime: 1700000000 + e}},
			});
			events.push({
				eventName: 'AccountSharedRewardUpdated',
				address: GEMS_GENERATOR,
				args: {
					account,
					sharedRateStatus: {
						points: BigInt(e * 7),
						totalRewardPerPointAccounted: BigInt(e) * 10n ** 20n,
						rewardsToWithdraw: BigInt(e) * 10n ** 14n,
					},
					timestamp: BigInt(1700000000 + e),
				},
			});
			events.push({
				eventName: 'GlobalRewardUpdated',
				address: GEMS_GENERATOR,
				args: {
					globalStatus: {
						lastUpdateTime: 1700000000 + e,
						totalRewardPerPointAtLastUpdate: BigInt(e) * 10n ** 21n,
						totalPoints: BigInt(e * 13),
					},
				},
			});
		}
	}

	// Lay the events into blocks, so that ONE BLOCK IS ONE BATCH downstream.
	const blocks: GeneratedBlock[] = [];
	for (let i = 0; i < events.length; i += eventsPerBlock) {
		const number = startBlock + blocks.length;
		const hash = `0x${number.toString(16).padStart(64, '0')}`;
		const slice = events.slice(i, i + eventsPerBlock).map((event, index) => ({
			...event,
			blockNumber: number,
			blockHash: hash,
			logIndex: index,
			transactionIndex: 0,
			transactionHash: `0x${(number * 100 + index).toString(16).padStart(64, '0')}`,
			removed: false,
			data: '0x',
			topics: [],
			blockTimestamp: 1710000000 + blocks.length * 2,
		}));
		blocks.push({number, hash, timestamp: 1710000000 + blocks.length * 2, events: slice});
	}
	return blocks;
}

/**
 * The named sizes the sweep uses.
 *
 * `gridSize` is what bounds the live set: play saturates a grid, so cells stop
 * being created and start being overwritten, which is exactly the "small live
 * set, block-paced writes" claim under test. The last two sizes deliberately
 * leave that regime.
 */
export const WORKLOAD_SIZES = {
	tiny: {epochs: 8, playersPerEpoch: 2, movesPerPlayer: 4, gridSize: 12},
	small: {epochs: 20, playersPerEpoch: 4, movesPerPlayer: 6, gridSize: 40},
	medium: {epochs: 40, playersPerEpoch: 8, movesPerPlayer: 10, gridSize: 160},
	large: {epochs: 80, playersPerEpoch: 16, movesPerPlayer: 16, gridSize: 700},
	huge: {epochs: 160, playersPerEpoch: 32, movesPerPlayer: 20, gridSize: 2000},
	/**
	 * The one that can actually locate a crossover.
	 *
	 * The five sizes above grow the dataset and the BATCH at the same time, so a
	 * cost that moves between them cannot be attributed to either. This one holds
	 * the batch fixed (same players, same moves, so roughly the same mutations per
	 * block throughout) and lets only the dataset grow, over many blocks. Per-block
	 * timings across one run of it are then a curve of cost against dataset size,
	 * measured inside a single warm process.
	 */
	sweep: {epochs: 200, playersPerEpoch: 6, movesPerPlayer: 8, gridSize: 900},
} as const satisfies Record<string, WorkloadSpec>;

export type WorkloadSize = keyof typeof WORKLOAD_SIZES;
