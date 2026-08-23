/**
 * `StratagemsContract`, ported to `MutationContext`.
 *
 * DERIVED WORK of github.com/wighawag/stratagems `common/src/stratagems.ts`
 * @ 3d5a0b3f (GPL-3.0); see `../../vendor/stratagems/README.md`.
 *
 * The port is deliberately mechanical, so that what it costs is visible:
 *
 *   - every method that touches state is now `async`, and every state read is
 *     an `await`. That is the spec's "handlers are uniformly async" decision
 *     paid in full: 4 reads become 4 awaits inside `updateNeighbours`, which is
 *     itself awaited from three call sites, and the async colour spreads to
 *     EVERY method including the pure-arithmetic ones that call them.
 *   - `this.state.cells[p] = c` becomes `ctx.set('cell', {position}, ...)`, and
 *     `this.state.cells[p]` becomes `await ctx.get('cell', {position})`.
 *   - `getCellInMemory` still returns a zero-filled default for an absent cell
 *     and still does NOT write it, which matters: a read must not create rows.
 *
 * Nothing about the ALGORITHM changed. Line for line it is the same traversal,
 * which is what makes the equality check meaningful.
 */
import type {MutationContext} from '../../../../../packages/processor-sqlite/dist/index.js';
import {EVIL_OWNER_ADDRESS} from '../../vendor/stratagems/constants.js';
import {Color} from '../../vendor/stratagems/types.js';
import type {ContractCell, ContractMove, ContractSimpleCell} from '../../vendor/stratagems/types.js';

const zeroAddress = '0x0000000000000000000000000000000000000000' as const;

export function countBits(n: number): number {
	let count = 0;
	while (n != 0) {
		n = n & (n - 1);
		count++;
	}
	return count;
}

export function bigIntIDToXY(position: bigint): {x: number; y: number} {
	const bn = BigInt(position);
	const x = Number(BigInt.asIntN(32, bn));
	const y = Number(BigInt.asIntN(32, bn >> 32n));
	return {x, y};
}

export function xyToBigIntID(x: number, y: number): bigint {
	return (x < 0 ? 2n ** 32n + BigInt(x) : BigInt(x)) + ((y < 0 ? 2n ** 32n + BigInt(y) : BigInt(y)) << 32n);
}

const CELL_FIELDS = [
	'lastEpochUpdate',
	'epochWhenTokenIsAdded',
	'color',
	'life',
	'delta',
	'enemyMap',
	'distribution',
	'stake',
	'producingEpochs',
] as const;

function rowToCell(row: Record<string, unknown> | undefined): ContractCell {
	return {
		lastEpochUpdate: Number(row?.lastEpochUpdate ?? 0),
		epochWhenTokenIsAdded: Number(row?.epochWhenTokenIsAdded ?? 0),
		color: Number(row?.color ?? 0),
		life: Number(row?.life ?? 0),
		delta: Number(row?.delta ?? 0),
		enemyMap: Number(row?.enemyMap ?? 0),
		distribution: Number(row?.distribution ?? 0),
		stake: Number(row?.stake ?? 0),
		producingEpochs: Number(row?.producingEpochs ?? 0),
	};
}

function cellToRow(cell: ContractCell): Record<string, unknown> {
	const row: Record<string, unknown> = {};
	for (const field of CELL_FIELDS) {
		row[field] = cell[field];
	}
	return row;
}

export class StratagemsContractOnEntities {
	constructor(
		private ctx: MutationContext,
		public MAX_LIFE: number,
	) {}

	_effectiveDelta(delta: number, enemyMap: number): number {
		let effectiveDelta = delta > 0 ? 1 : -1;
		if (effectiveDelta < 0 && enemyMap == 0) {
			effectiveDelta = 1;
		}
		return effectiveDelta;
	}

	computeNewLife(
		lastUpdate: number,
		enemyMap: number,
		delta: number,
		life: number,
		epoch: number,
	): {newLife: number; epochUsed: number} {
		const MAX_LIFE = this.MAX_LIFE;

		const data = {
			newLife: life,
			epochUsed: lastUpdate,
		};
		if (lastUpdate >= 1 && life > 0) {
			let epochDelta = epoch - lastUpdate;
			if (epochDelta > 0) {
				const effectiveDelta = this._effectiveDelta(delta, enemyMap);
				if (effectiveDelta > 0) {
					const maxEpoch = MAX_LIFE - life + Math.floor((effectiveDelta - 1) / effectiveDelta);
					if (epochDelta > maxEpoch) {
						epochDelta = maxEpoch;
					}

					life += epochDelta * effectiveDelta;
					if (life > MAX_LIFE) {
						life = MAX_LIFE;
					}
					data.newLife = life;
					data.epochUsed = epoch;
				} else if (effectiveDelta < 0) {
					const numEpochBeforeDying = life + Math.floor((-effectiveDelta - 1) / -effectiveDelta);
					if (epochDelta > numEpochBeforeDying) {
						epochDelta = numEpochBeforeDying;
					}
					const lifeLoss = epochDelta * -effectiveDelta;
					if (lifeLoss > life) {
						data.newLife = 0;
					} else {
						data.newLife = life - lifeLoss;
					}
					data.epochUsed = lastUpdate + epochDelta;
				} else {
					data.newLife = life;
					data.epochUsed = epoch;
				}
			} else {
				data.newLife = life;
				data.epochUsed = lastUpdate;
			}
		}

		return data;
	}

	/** A read that must NOT create a row: an absent cell reads as the zero cell. */
	async getCellInMemory(position: bigint): Promise<ContractCell> {
		const row = await this.ctx.get('cell', {position: position.toString()});
		return rowToCell(row as Record<string, unknown> | undefined);
	}

	async putCell(position: bigint, cell: ContractCell): Promise<void> {
		this.ctx.set('cell', {position: position.toString()}, cellToRow(cell));
	}

	async getUpdatedCell(position: bigint, epoch: number) {
		const updatedCell = await this.getCellInMemory(position);
		let justDied = false;
		const lastUpdate = updatedCell.lastEpochUpdate;
		const life = updatedCell.life;

		if (lastUpdate >= 1 && life > 0) {
			const {newLife} = this.computeNewLife(
				updatedCell.lastEpochUpdate,
				updatedCell.enemyMap,
				updatedCell.delta,
				updatedCell.life,
				epoch,
			);
			updatedCell.life = newLife;
			updatedCell.lastEpochUpdate = epoch;
			justDied = newLife == 0;
		}

		const effectiveDelta = this._effectiveDelta(updatedCell.delta, updatedCell.enemyMap);
		if (effectiveDelta > 0) {
			updatedCell.producingEpochs += epoch - lastUpdate;
		}

		return {updatedCell, justDied};
	}

	async ownerOf(position: bigint): Promise<`0x${string}`> {
		const row = (await this.ctx.get('cellOwner', {position: position.toString()})) as
			| {owner: `0x${string}`}
			| undefined;
		return row?.owner || zeroAddress;
	}

	async setOwner(position: bigint, owner: `0x${string}`): Promise<void> {
		this.ctx.set('cellOwner', {position: position.toString()}, {owner});
	}

	async addPoints(owner: `0x${string}`, points: number): Promise<void> {
		const row = (await this.ctx.get('computedPoints', {owner})) as {points: number} | undefined;
		const existingPoints = Number(row?.points ?? 0);
		this.ctx.set('computedPoints', {owner}, {points: existingPoints + points});
	}

	async removePoints(owner: `0x${string}`, points: number): Promise<void> {
		const row = (await this.ctx.get('computedPoints', {owner})) as {points: number} | undefined;
		const existingPoints = Number(row?.points ?? 0);
		this.ctx.set('computedPoints', {owner}, {points: existingPoints - points});
	}

	async updateCellFromNeighbor(
		position: bigint,
		cell: ContractCell,
		newLife: number,
		epoch: number,
		neighbourIndex: number,
		oldColor: Color,
		newColor: Color,
	): Promise<number> {
		let due = 0;
		if (cell.life > 0 && newLife == 0) {
			cell.distribution = (cell.enemyMap << 4) + countBits(cell.enemyMap);
		}

		if (((cell.distribution >> 4) & (2 ** neighbourIndex)) == 2 ** neighbourIndex) {
			due = 12 / (cell.distribution & 0x0f);
			cell.distribution = ((cell.distribution >> 4) & (~(2 ** neighbourIndex) << 4)) + (cell.distribution & 0x0f);
		}

		const oldEffectiveDelta = this._effectiveDelta(cell.delta, cell.enemyMap);

		if (oldColor != newColor) {
			if (newColor == Color.None) {
				if (cell.color == oldColor) {
					cell.delta -= 1;
				} else {
					cell.delta += 1;
					cell.enemyMap = cell.enemyMap & ((1 << neighbourIndex) ^ 0xff);
				}
			} else if (cell.color == oldColor) {
				cell.enemyMap = cell.enemyMap | (1 << neighbourIndex);
				cell.delta -= 2;
			} else if (cell.color == newColor) {
				cell.delta += oldColor == Color.None ? 1 : 2;
				cell.enemyMap = cell.enemyMap & ((1 << neighbourIndex) ^ 0xff);
			} else if (oldColor == Color.None) {
				cell.delta -= 1;
				cell.enemyMap = cell.enemyMap | (1 << neighbourIndex);
			}
		}

		const owner = await this.ownerOf(position);
		if (owner != zeroAddress && newLife > 0) {
			const newEffectiveDelta = this._effectiveDelta(cell.delta, cell.enemyMap);
			if (oldEffectiveDelta > 0 && newEffectiveDelta <= 0) {
				await this.removePoints(owner, cell.stake);
			} else if (oldEffectiveDelta <= 0 && newEffectiveDelta > 0) {
				await this.addPoints(owner, cell.stake);
			}
		}

		if (oldEffectiveDelta > 0) {
			cell.producingEpochs += epoch - cell.lastEpochUpdate;
		}

		cell.lastEpochUpdate = epoch;
		cell.life = newLife;
		await this.putCell(position, cell);
		return due;
	}

	async updateCell(position: bigint, epoch: number, neighbourIndex: number, oldColor: Color, newColor: Color) {
		const data = {
			enemyOrFriend: 0,
			due: 0,
		};
		const cell = await this.getCellInMemory(position);

		const lastUpdate = cell.lastEpochUpdate;
		const color = cell.color;
		if (color != Color.None) {
			data.enemyOrFriend = color == newColor ? 1 : -1;
		}

		if (lastUpdate >= 1 && color != Color.None) {
			if (cell.life > 0 && lastUpdate < epoch) {
				const {newLife} = this.computeNewLife(lastUpdate, cell.enemyMap, cell.delta, cell.life, epoch);
				data.due = await this.updateCellFromNeighbor(
					position,
					cell,
					newLife,
					epoch,
					neighbourIndex,
					oldColor,
					newColor,
				);
			} else {
				data.due = await this.updateCellFromNeighbor(
					position,
					cell,
					cell.life,
					epoch,
					neighbourIndex,
					oldColor,
					newColor,
				);
			}
		}

		return data;
	}

	async updateNeighbours(
		position: bigint,
		epoch: number,
		oldColor: Color,
		newColor: Color,
		distribution: number,
	): Promise<{newComputedDelta: number; newComputedEnemyMap: number; numDue: number}> {
		const {x, y} = bigIntIDToXY(position);
		const data = {
			newComputedDelta: 0,
			newComputedEnemyMap: 0,
			numDue: 0,
		};

		{
			const upPosition = xyToBigIntID(x, y - 1);
			const {enemyOrFriend, due} = await this.updateCell(upPosition, epoch, 2, oldColor, newColor);
			if (enemyOrFriend < 0) {
				data.newComputedEnemyMap = data.newComputedEnemyMap | 1;
			}
			data.numDue += due;
			data.newComputedDelta += enemyOrFriend;
		}

		{
			const leftPosition = xyToBigIntID(x - 1, y);
			const {enemyOrFriend, due} = await this.updateCell(leftPosition, epoch, 3, oldColor, newColor);
			if (enemyOrFriend < 0) {
				data.newComputedEnemyMap = data.newComputedEnemyMap | 2;
			}
			data.numDue += due;
			data.newComputedDelta += enemyOrFriend;
		}

		{
			const downPosition = xyToBigIntID(x, y + 1);
			const {enemyOrFriend, due} = await this.updateCell(downPosition, epoch, 0, oldColor, newColor);
			if (enemyOrFriend < 0) {
				data.newComputedEnemyMap = data.newComputedEnemyMap | 4;
			}
			data.numDue += due;
			data.newComputedDelta += enemyOrFriend;
		}

		{
			const rightPosition = xyToBigIntID(x + 1, y);
			const {enemyOrFriend, due} = await this.updateCell(rightPosition, epoch, 1, oldColor, newColor);
			if (enemyOrFriend < 0) {
				data.newComputedEnemyMap = data.newComputedEnemyMap | 8;
			}
			data.numDue += due;
			data.newComputedDelta += enemyOrFriend;
		}

		return data;
	}

	async propagate(move: ContractMove, epoch: number, color: Color, distribution: number) {
		const data = {
			newDelta: 0,
			newEnemyMap: 0,
		};

		const {newComputedDelta, newComputedEnemyMap} = await this.updateNeighbours(
			move.position,
			epoch,
			color,
			move.color,
			distribution,
		);

		data.newDelta = newComputedDelta;
		data.newEnemyMap = newComputedEnemyMap;

		return data;
	}

	async computeMove(player: `0x${string}`, epoch: number, moveAsInput: ContractMove): Promise<void> {
		const move = {...moveAsInput};
		const MAX_LIFE = this.MAX_LIFE;

		const {updatedCell: currentState, justDied} = await this.getUpdatedCell(move.position, epoch);
		const oldEffectiveDelta = this._effectiveDelta(currentState.delta, currentState.enemyMap);

		const oldLife = currentState.life;

		let distribution = currentState.distribution;
		if (justDied) {
			distribution = (currentState.enemyMap << 4) + countBits(currentState.enemyMap);
			currentState.lastEpochUpdate = 0;
		}

		if (move.color == Color.None) {
			if (
				currentState.life != MAX_LIFE ||
				(await this.ownerOf(move.position)).toLowerCase() != player.toLowerCase()
			) {
				return;
			}
		} else if (currentState.epochWhenTokenIsAdded == epoch) {
			if (currentState.life != 0) {
				move.color = Color.Evil;
			} else {
				return;
			}
		}

		const {newDelta, newEnemyMap} = await this.propagate(move, epoch, currentState.color, distribution);

		currentState.color = move.color;
		currentState.distribution = 0;
		if (!((await this.ownerOf(move.position)).toLowerCase() == player.toLowerCase() && currentState.life > 0)) {
			currentState.epochWhenTokenIsAdded = epoch;
		}

		if (currentState.color == Color.None) {
			currentState.producingEpochs += epoch - currentState.lastEpochUpdate;
			currentState.life = 0;
			currentState.stake = 0;
			currentState.lastEpochUpdate = 0;
			currentState.delta = 0;
			currentState.enemyMap = 0;
			await this.setOwner(move.position, zeroAddress);
			if (oldEffectiveDelta > 0) {
				await this.removePoints(player, 1);
			}
		} else {
			currentState.enemyMap = newEnemyMap;

			if (currentState.color == Color.Evil && currentState.life != 0) {
				currentState.stake += 1;
				if (currentState.stake > 255) {
					currentState.stake = 255;
				}
			} else {
				currentState.stake = 1;
				currentState.producingEpochs = 0;
			}

			currentState.delta = newDelta;
			currentState.life = 2;
			currentState.lastEpochUpdate = epoch;

			const oldOwner = await this.ownerOf(move.position);

			const newEffectiveDelta = this._effectiveDelta(currentState.delta, currentState.enemyMap);

			if (currentState.color == Color.Evil) {
				if (oldOwner != EVIL_OWNER_ADDRESS) {
					if (oldOwner == zeroAddress) {
						if (newEffectiveDelta > 0) {
							await this.addPoints(EVIL_OWNER_ADDRESS as `0x${string}`, 1);
						}
					} else {
						if (oldEffectiveDelta <= 0 && newEffectiveDelta > 0) {
							await this.addPoints(EVIL_OWNER_ADDRESS as `0x${string}`, 2);
						} else if (oldEffectiveDelta > 0 && newEffectiveDelta <= 0) {
							await this.removePoints(oldOwner, 1);
						} else if (oldEffectiveDelta <= 0 && newEffectiveDelta <= 0) {
						} else if (oldEffectiveDelta > 0 && newEffectiveDelta > 0) {
							if (oldLife > 0) {
								await this.removePoints(oldOwner, 1);
								await this.addPoints(EVIL_OWNER_ADDRESS as `0x${string}`, 2);
							} else {
								console.error(`collision for black can only happen when tile are placed, so life > 0`);
								await this.addPoints(EVIL_OWNER_ADDRESS as `0x${string}`, 1);
							}
						}
					}
					await this.setOwner(move.position, EVIL_OWNER_ADDRESS as `0x${string}`);
				} else if (newEffectiveDelta > 0) {
					await this.addPoints(EVIL_OWNER_ADDRESS as `0x${string}`, 1);
				}
			} else {
				if (currentState.epochWhenTokenIsAdded != epoch && oldEffectiveDelta > 0) {
					await this.removePoints(player, 1);
				}
				if (newEffectiveDelta > 0) {
					await this.addPoints(player, 1);
				}
				await this.setOwner(move.position, player);
			}
		}

		await this.putCell(move.position, currentState);
	}

	// ----------------------

	async forceSimpleCells(epoch: number, cells: readonly ContractSimpleCell[]): Promise<void> {
		for (const simpleCell of cells) {
			const {delta, enemyMap} = await this.updateNeighbosrDelta(simpleCell.position, simpleCell.color, epoch);

			await this.putCell(simpleCell.position, {
				lastEpochUpdate: epoch,
				epochWhenTokenIsAdded: epoch,
				color: simpleCell.color,
				life: simpleCell.life,
				delta: delta,
				enemyMap: enemyMap,
				distribution: 0,
				stake: simpleCell.stake,
				producingEpochs: 0, // THIS IS FALSE but we go with it
			});
			await this.setOwner(simpleCell.position, simpleCell.owner);
		}

		for (const simpleCell of cells) {
			const cell = await this.getCellInMemory(simpleCell.position);

			const effectiveDelta = this._effectiveDelta(cell.delta, cell.enemyMap);
			let potentialLife = cell.life - effectiveDelta;
			if (potentialLife < 0) {
				potentialLife = 0;
			}
			cell.life = potentialLife;

			const newCell = {
				lastEpochUpdate: epoch - 1,
				epochWhenTokenIsAdded: epoch - 1,
				color: cell.color,
				life: cell.life,
				delta: cell.delta,
				enemyMap: cell.enemyMap,
				distribution: 0,
				stake: cell.stake,
				producingEpochs: 0,
			};

			if (this._effectiveDelta(newCell.delta, newCell.enemyMap) > 0) {
				newCell.producingEpochs = 1;
			}

			await this.putCell(simpleCell.position, newCell);
		}
	}

	async updateNeighbosrDelta(
		center: bigint,
		color: Color,
		epoch: number,
	): Promise<{delta: number; enemyMap: number}> {
		const {x, y} = bigIntIDToXY(center);
		const data = {delta: 0, enemyMap: 0};

		{
			const upPosition = xyToBigIntID(x, y - 1);
			const cell = await this.getCellInMemory(upPosition);
			if (cell.color != Color.None) {
				const enemyOrFriend = this.isEnemyOrFriend(color, cell.color);
				if (enemyOrFriend < 0) {
					data.enemyMap = data.enemyMap | 1;
				}
				data.delta += enemyOrFriend;
				await this.updateCellFromNeighbor(upPosition, cell, cell.life, epoch, 2, Color.None, color);
			}
		}
		{
			const leftPosition = xyToBigIntID(x - 1, y);
			const cell = await this.getCellInMemory(leftPosition);
			if (cell.color != Color.None) {
				const enemyOrFriend = this.isEnemyOrFriend(color, cell.color);
				if (enemyOrFriend < 0) {
					data.enemyMap = data.enemyMap | 2;
				}
				data.delta += enemyOrFriend;
				await this.updateCellFromNeighbor(leftPosition, cell, cell.life, epoch, 3, Color.None, color);
			}
		}

		{
			const downPosition = xyToBigIntID(x, y + 1);
			const cell = await this.getCellInMemory(downPosition);
			if (cell.color != Color.None) {
				const enemyOrFriend = this.isEnemyOrFriend(color, cell.color);
				if (enemyOrFriend < 0) {
					data.enemyMap = data.enemyMap | 4;
				}
				data.delta += enemyOrFriend;
				await this.updateCellFromNeighbor(downPosition, cell, cell.life, epoch, 0, Color.None, color);
			}
		}
		{
			const rightPosition = xyToBigIntID(x + 1, y);
			const cell = await this.getCellInMemory(rightPosition);
			if (cell.color != Color.None) {
				const enemyOrFriend = this.isEnemyOrFriend(color, cell.color);
				if (enemyOrFriend < 0) {
					data.enemyMap = data.enemyMap | 8;
				}
				data.delta += enemyOrFriend;
				await this.updateCellFromNeighbor(rightPosition, cell, cell.life, epoch, 1, Color.None, color);
			}
		}
		return data;
	}

	async poke(position: bigint, epoch: number): Promise<void> {
		const {updatedCell: currentState, justDied} = await this.getUpdatedCell(position, epoch);

		let distribution = currentState.distribution;
		if (justDied) {
			distribution = (currentState.enemyMap << 4) + countBits(currentState.enemyMap);
			currentState.lastEpochUpdate = 0;
		}

		await this.updateNeighbours(position, epoch, currentState.color, currentState.color, distribution);

		currentState.distribution = 0;
		await this.putCell(position, currentState);
	}

	isEnemyOrFriend(a: Color, b: Color) {
		if (a != Color.None && b != Color.None) {
			return a == b ? 1 : -1;
		}
		return 0;
	}
}
