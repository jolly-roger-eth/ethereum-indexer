/**
 * The stratagems processor, ported to the spec's `MutationContext` API.
 *
 * DERIVED WORK of github.com/wighawag/stratagems `indexer/src/index.ts`
 * @ 3d5a0b3f (GPL-3.0); see `../../vendor/stratagems/README.md`. The oracle it
 * is checked against is that file, vendored verbatim.
 *
 * Read this next to `../../vendor/stratagems/js-processor.ts`. Handlers that
 * touch flat keyed maps (`onCommitmentMade`, the reward handlers, the pokes)
 * port across almost unchanged. `onCommitmentRevealed` does not, and the
 * distance between the two versions of THAT handler is the answer to the spec's
 * third open question.
 */
import type {SQLProcessor, MutationContext} from '../../../../../packages/processor-sqlite/dist/index.js';
import type {StratagemsABI} from '../../vendor/stratagems/abi.js';
import {SINGLETON, stratagemsEntities} from './entities.js';
import {StratagemsContractOnEntities} from './stratagems-contract.js';

/** The bounded window `state.placements` keeps. Verbatim from the original's `> 7`. */
const PLACEMENT_WINDOW = 7;

function parseList(value: unknown): string[] {
	const text = typeof value === 'string' ? value : '';
	return text.length === 0 ? [] : text.split(',');
}

/**
 * Drop one epoch's placements, by hand, in the only way the model allows.
 *
 * CONTORTION, and the sharpest one in the port. In the original this is
 * `state.placements.pop()`: one call, and everything nested under the popped
 * entry goes with it. Here nothing can ask the store "which rows belong to
 * epoch N", because `MutationContext` is get/set/delete BY ID, so the handler
 * has to have written down the answer in advance (`placement.positions`,
 * `placementCell.playerCount`) and then walk it. The cost is a denormalised
 * foreign key maintained in handler code, plus O(cells x players) reads and
 * deletes to do what an array does in one operation.
 */
async function dropPlacementEpoch(ctx: MutationContext, epoch: number): Promise<void> {
	const placement = (await ctx.get('placement', {epoch})) as {positions?: string} | undefined;
	for (const position of parseList(placement?.positions)) {
		const cell = (await ctx.get('placementCell', {epoch, position})) as {playerCount?: number} | undefined;
		const playerCount = Number(cell?.playerCount ?? 0);
		for (let index = 0; index < playerCount; index++) {
			ctx.delete('placementPlayer', {epoch, position, playerIndex: index});
		}
		ctx.delete('placementCell', {epoch, position});
	}
	ctx.delete('placement', {epoch});
}

export const stratagemsPortedProcessor: SQLProcessor<StratagemsABI> = {
	version: 'spike-sqlite-in-the-browser/stratagems-port@3d5a0b3f',
	entities: stratagemsEntities,

	async onCommitmentRevealed(state, event) {
		const epoch = event.args.epoch;
		const account = event.args.player.toLowerCase();

		// `state.placements.find(v => v.epoch === ...)` becomes a lookup in a
		// hand-maintained ordered index, because an ordered bounded array has no
		// counterpart in the entity model.
		const windowRow = (await state.get('placementWindow', SINGLETON)) as {epochs?: string} | undefined;
		const epochs = parseList(windowRow?.epochs);
		if (epochs.indexOf(String(epoch)) === -1) {
			state.set('placement', {epoch}, {positions: ''});
			epochs.unshift(String(epoch)); // the original's `placements.unshift(...)`
			if (epochs.length > PLACEMENT_WINDOW) {
				const dropped = epochs.pop() as string; // ... and its `placements.pop()`
				await dropPlacementEpoch(state, Number(dropped));
			}
			state.set('placementWindow', SINGLETON, {epochs: epochs.join(',')});
		}

		const stratagemsContract = new StratagemsContractOnEntities(state, 7);
		for (const move of event.args.moves) {
			await stratagemsContract.computeMove(event.args.player, event.args.epoch, move);

			const position = move.position.toString();
			// `cell.players.push({...})` becomes read-count, write-at-count,
			// write-count-plus-one: an append is three operations, and the count
			// is an aggregation the model parks.
			const placementCell = (await state.get('placementCell', {epoch, position})) as
				| {playerCount?: number}
				| undefined;
			if (!placementCell) {
				const placement = (await state.get('placement', {epoch})) as {positions?: string} | undefined;
				const positions = parseList(placement?.positions);
				positions.push(position);
				state.set('placement', {epoch}, {positions: positions.join(',')});
			}
			const index = Number(placementCell?.playerCount ?? 0);
			state.set(
				'placementPlayer',
				{epoch, position, playerIndex: index},
				{color: move.color, address: account},
			);
			state.set('placementCell', {epoch, position}, {playerCount: index + 1});
		}

		state.delete('commitment', {account});
	},

	async onSinglePoke(state, event) {
		const stratagemsContract = new StratagemsContractOnEntities(state, 7);
		await stratagemsContract.poke(event.args.position, event.args.epoch);
	},

	async onMultiPoke(state, event) {
		const stratagemsContract = new StratagemsContractOnEntities(state, 7);
		for (const position of event.args.positions) {
			await stratagemsContract.poke(position, event.args.epoch);
		}
	},

	onCommitmentCancelled(state, event) {
		const account = event.args.player.toLowerCase();
		state.delete('commitment', {account});
	},

	onCommitmentMade(state, event) {
		const account = event.args.player.toLowerCase();
		state.set('commitment', {account}, {epoch: event.args.epoch, hash: event.args.commitmentHash});
	},

	onCommitmentVoid(state, event) {
		const account = event.args.player.toLowerCase();
		state.delete('commitment', {account});
	},

	onReserveDeposited(state, event) {},
	onReserveWithdrawn(state, event) {},

	// --------------------------

	async onForceSimpleCells(state, event) {
		const stratagemsContract = new StratagemsContractOnEntities(state, 7);
		await stratagemsContract.forceSimpleCells(event.args.epoch, event.args.cells as any);
	},

	// The three reward handlers are the flat case, and they port one-to-one apart
	// from the u256 fields, which the declarable column types cannot hold: every
	// one of them is written as decimal TEXT and read back through `BigInt()`.
	onAccounFixedRewardUpdated(state, event) {
		state.set(
			'fixedRate',
			{account: event.args.account},
			{
				toWithdraw: event.args.fixedRateStatus.toWithdraw.toString(),
				lastTime: event.args.fixedRateStatus.lastTime,
			},
		);
	},

	onAccountSharedRewardUpdated(state, event) {
		state.set(
			'sharedRate',
			{account: event.args.account},
			{
				points: event.args.sharedRateStatus.points.toString(),
				totalRewardPerPointAccounted: event.args.sharedRateStatus.totalRewardPerPointAccounted.toString(),
				rewardsToWithdraw: event.args.sharedRateStatus.rewardsToWithdraw.toString(),
			},
		);
	},

	onGlobalRewardUpdated(state, event) {
		state.set(
			'globalRate',
			SINGLETON,
			{
				lastUpdateTime: event.args.globalStatus.lastUpdateTime,
				totalRewardPerPointAtLastUpdate: event.args.globalStatus.totalRewardPerPointAtLastUpdate.toString(),
				totalPoints: event.args.globalStatus.totalPoints.toString(),
			},
		);
	},
};
