/**
 * The stratagems `JSProcessor`, VENDORED VERBATIM apart from its imports.
 *
 * Origin: github.com/wighawag/stratagems, `indexer/src/index.ts`
 * @ commit 3d5a0b3f46bcc0d8370643b8382f11f99f81df00 (2024-12-18), GPL-3.0.
 *
 * This is the PROVENANCE of the golden states. Its handler bodies are
 * byte-for-byte the ones that computed the state the port is compared against,
 * which is the whole point: an expected value computed by our own
 * reimplementation would prove nothing.
 *
 * **Nothing runs it any more.** The free-form authoring path that drove it
 * (`fromJSProcessor`) is deleted (ADR-0037), so the golden states are a FROZEN
 * expectation rather than a recomputable one -- see `../../fixtures/README.md`.
 * This file stays because deleting it would leave the goldens as numbers with no
 * stated origin, which is the one property that made them worth their weight.
 *
 * Changes, all mechanical:
 *   - `contractsInfo` (a build-time generated module) is replaced by the
 *     vendored `stratagemsABI`, so `ContractsABI` is a literal type here.
 *   - imports point at the vendored files, including `JSProcessor` itself, whose
 *     package (`@etherfold/js-processor`, once `ethereum-indexer-js-processor`)
 *     is deleted: the type is vendored beside this file as
 *     `js-processor-type.ts`.
 *   - the `version` string keeps the spike's spelling, because CHANGING it would
 *     change nothing about what this computes and would break the link between
 *     the committed golden states and the run that produced them.
 *   - `version` is a literal rather than the `__VERSION_HASH__` placeholder
 *     that stratagems' build substitutes.
 */
import type {JSProcessor} from './js-processor-type.js';
import {StratagemsContract, bigIntIDToXY} from './stratagems.js';
import {Color} from './types.js';
import type {ContractCell} from './types.js';
import type {StratagemsABI} from './abi.js';

export type CellPlacements = {
	players: {color: Color; address: string}[];
};

export type SharedRatePerAccount = {
	points: bigint;
	totalRewardPerPointAccounted: bigint;
	rewardsToWithdraw: bigint;
};

export type FixedRatePerAccount = {
	toWithdraw: bigint;
	lastTime: number;
};

export type GlobalRate = {
	lastUpdateTime: number;
	totalRewardPerPointAtLastUpdate: bigint;
	totalPoints: bigint;
};

export type EpochPlacements = {
	epoch: number;
	cells: {
		[position: string]: CellPlacements;
	};
};

export type Data = {
	cells: {
		[position: string]: ContractCell;
	};
	owners: {
		[position: string]: `0x${string}`;
	};
	commitments: {
		[address: string]: {epoch: number; hash: `0x${string}`};
	};
	placements: EpochPlacements[];
	points: {
		global: GlobalRate;
		fixed: {
			[address: string]: FixedRatePerAccount;
		};
		shared: {
			[address: string]: SharedRatePerAccount;
		};
	};
	computedPoints: {[player: string]: number};
};

type ContractsABI = StratagemsABI;

export const StratagemsIndexerProcessor: JSProcessor<ContractsABI, Data> = {
	// version is automatically populated via version.cjs to let the browser knows to reindex on changes
	version: 'spike-sqlite-in-the-browser/stratagems@3d5a0b3f', //
	construct(): Data {
		return {
			cells: {},
			owners: {},
			commitments: {},
			placements: [],
			points: {
				global: {lastUpdateTime: 0, totalRewardPerPointAtLastUpdate: 0n, totalPoints: 0n},
				fixed: {},
				shared: {},
			},
			computedPoints: {},
		};
	},
	onCommitmentRevealed(state, event) {
		const epoch = event.args.epoch;
		const account = event.args.player.toLowerCase();

		let epochEvents = state.placements.find((v) => v.epoch === event.args.epoch);
		if (!epochEvents) {
			epochEvents = {
				epoch,
				cells: {},
			};
			state.placements.unshift(epochEvents);
			if (state.placements.length > 7) {
				state.placements.pop();
			}
		}

		const stratagemsContract = new StratagemsContract(state, 7);
		for (const move of event.args.moves) {
			stratagemsContract.computeMove(event.args.player, event.args.epoch, move);

			let cell = epochEvents.cells[move.position.toString()];
			if (!cell) {
				epochEvents.cells[move.position.toString()] = cell = {
					players: [],
				};
			}
			cell.players.push({
				color: move.color,
				address: account,
			});
		}

		// TODO only keep track of the connected player ?
		delete state.commitments[account];
	},
	onSinglePoke(state, event) {
		const stratagemsContract = new StratagemsContract(state, 7);
		stratagemsContract.poke(event.args.position, event.args.epoch);
	},
	onMultiPoke(state, event) {
		const stratagemsContract = new StratagemsContract(state, 7);
		for (const position of event.args.positions) {
			// console.log({position: position, pos: bigIntIDToXY(position)});
			stratagemsContract.poke(position, event.args.epoch);
		}
	},
	onCommitmentCancelled(state, event) {
		const account = event.args.player.toLowerCase();
		// TODO only keep track of the connected player ?
		delete state.commitments[account];
	},
	onCommitmentMade(state, event) {
		const account = event.args.player.toLowerCase();
		// TODO only keep track of the connected player ?
		state.commitments[account] = {epoch: event.args.epoch, hash: event.args.commitmentHash};
	},
	onCommitmentVoid(state, event) {
		const account = event.args.player.toLowerCase();
		// TODO only keep track of the connected player ?
		delete state.commitments[account];
	},
	onReserveDeposited(state, event) {},
	onReserveWithdrawn(state, event) {},
	// onTimeIncreased(state, event) {},

	// --------------------------

	onForceSimpleCells(state, event) {
		const stratagemsContract = new StratagemsContract(state, 7);
		stratagemsContract.forceSimpleCells(event.args.epoch, event.args.cells as any);
	},

	onAccounFixedRewardUpdated(state, event) {
		state.points.fixed[event.args.account] = event.args.fixedRateStatus;
	},

	onAccountSharedRewardUpdated(state, event) {
		state.points.shared[event.args.account] = event.args.sharedRateStatus;
	},

	onGlobalRewardUpdated(state, event) {
		state.points.global = event.args.globalStatus;
	},
};
