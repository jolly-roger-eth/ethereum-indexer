/**
 * Entity rows, projected back into the shape the original processor produces.
 *
 * This is the equality oracle's other half, and it is itself evidence: the
 * amount of code needed HERE is the amount of structure the entity model could
 * not carry, and had to be rebuilt by a reader. A shape the model expresses
 * natively projects in one line; `placements` takes twenty and needs three
 * entities plus a hand-maintained index to do it.
 */
import type {MemoryBlockStore} from '../store/memory.js';
import type {Data} from '../../../../../packages/conformance-workload-stratagems/vendor/stratagems/js-processor.js';
import {SINGLETON} from './entities.js';

type Rows = Map<string, Map<string, Record<string, unknown>>>;

function group(store: MemoryBlockStore): Rows {
	const rows: Rows = new Map();
	for (const row of store.liveRows()) {
		let byId = rows.get(row.entity);
		if (!byId) {
			byId = new Map();
			rows.set(row.entity, byId);
		}
		byId.set(row.id, row.values);
	}
	return rows;
}

/** `position=123` back to `123`. The store keys rows by the declared id columns. */
function idValue(key: string, column: string): string {
	for (const part of key.split('|')) {
		const [name, ...rest] = part.split('=');
		if (name === column) return rest.join('=');
	}
	return '';
}

export function projectToData(store: MemoryBlockStore): Data {
	const rows = group(store);
	const data: Data = {
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

	for (const [key, values] of rows.get('cell') ?? []) {
		data.cells[idValue(key, 'position')] = {
			lastEpochUpdate: Number(values.lastEpochUpdate),
			epochWhenTokenIsAdded: Number(values.epochWhenTokenIsAdded),
			color: Number(values.color),
			life: Number(values.life),
			delta: Number(values.delta),
			enemyMap: Number(values.enemyMap),
			distribution: Number(values.distribution),
			stake: Number(values.stake),
			producingEpochs: Number(values.producingEpochs),
		};
	}

	for (const [key, values] of rows.get('cellOwner') ?? []) {
		data.owners[idValue(key, 'position')] = values.owner as `0x${string}`;
	}

	for (const [key, values] of rows.get('commitment') ?? []) {
		data.commitments[idValue(key, 'account')] = {
			epoch: Number(values.epoch),
			hash: values.hash as `0x${string}`,
		};
	}

	for (const [key, values] of rows.get('computedPoints') ?? []) {
		data.computedPoints[idValue(key, 'owner')] = Number(values.points);
	}

	const globalRate = rows.get('globalRate')?.get(`id=${SINGLETON.id}`);
	if (globalRate) {
		data.points.global = {
			lastUpdateTime: Number(globalRate.lastUpdateTime),
			totalRewardPerPointAtLastUpdate: BigInt(globalRate.totalRewardPerPointAtLastUpdate as string),
			totalPoints: BigInt(globalRate.totalPoints as string),
		};
	}

	for (const [key, values] of rows.get('fixedRate') ?? []) {
		data.points.fixed[idValue(key, 'account')] = {
			toWithdraw: BigInt(values.toWithdraw as string),
			lastTime: Number(values.lastTime),
		};
	}

	for (const [key, values] of rows.get('sharedRate') ?? []) {
		data.points.shared[idValue(key, 'account')] = {
			points: BigInt(values.points as string),
			totalRewardPerPointAccounted: BigInt(values.totalRewardPerPointAccounted as string),
			rewardsToWithdraw: BigInt(values.rewardsToWithdraw as string),
		};
	}

	// `placements` is where the projection stops being a rename. Its ORDER comes
	// from the hand-maintained window (arrival order, which no field carries),
	// its membership from `placement.positions`, and each cell's player list from
	// a count plus one row per index.
	const window = rows.get('placementWindow')?.get(`id=${SINGLETON.id}`);
	const epochs = typeof window?.epochs === 'string' && window.epochs.length > 0 ? window.epochs.split(',') : [];
	for (const epochText of epochs) {
		const epoch = Number(epochText);
		const placement = rows.get('placement')?.get(`epoch=${epochText}`);
		const positions =
			typeof placement?.positions === 'string' && placement.positions.length > 0
				? placement.positions.split(',')
				: [];
		const cells: Data['placements'][number]['cells'] = {};
		for (const position of positions) {
			const placementCell = rows.get('placementCell')?.get(`epoch=${epochText}|position=${position}`);
			const playerCount = Number(placementCell?.playerCount ?? 0);
			const players = [];
			for (let index = 0; index < playerCount; index++) {
				const player = rows
					.get('placementPlayer')
					?.get(`epoch=${epochText}|playerIndex=${index}|position=${position}`);
				if (!player) continue;
				players.push({color: Number(player.color), address: player.address as string});
			}
			cells[position] = {players} as Data['placements'][number]['cells'][string];
		}
		data.placements.push({epoch, cells});
	}

	return data;
}
