/**
 * VENDORED, VERBATIM apart from the four import lines below.
 *
 * Origin: github.com/wighawag/stratagems, `common/src/stratagems.ts`
 * @ commit 3d5a0b3f46bcc0d8370643b8382f11f99f81df00 (2024-12-18), licensed GPL-3.0.
 *
 * It is copied rather than imported so this spike stays re-runnable when a
 * sibling checkout moves, and so the equality oracle is the SAME BYTES that
 * computed the state we are comparing against. Its licence is not this repo's
 * (MIT): promoting any of it into a package needs a licence decision first, and
 * `work/notes/findings/sqlite-in-the-browser.md` says so.
 */
import {zeroAddress} from 'viem';
import type {CellXYPosition, ContractCell, ContractMove, ContractSimpleCell, StratagemsState} from './types.js';
import {Color} from './types.js';
import {EVIL_OWNER_ADDRESS} from './constants.js';

export function bigIntIDToXYID(position: bigint): string {
	const {x, y} = bigIntIDToXY(position);
	return '' + x + ',' + y;
}

export function countBits(n: number): number {
	let count = 0;
	while (n != 0) {
		n = n & (n - 1);
		count++;
	}
	return count;
}

// using 64 bits room id
// const leftMostBit = BigInt('0x8000000000000000');
// const bn32 = BigInt('0x10000000000000000');
export function bigIntIDToXY(position: bigint): CellXYPosition {
	const bn = BigInt(position);
	const x = Number(BigInt.asIntN(32, bn));
	const y = Number(BigInt.asIntN(32, bn >> 32n));
	// const rx = x >= leftMostBit ? -(bn32 - x) : x;
	// const ry = y >= leftMostBit ? -(bn32 - y) : y;
	return {x, y};
}

export type CellBigIntXYPosition = {
	x: bigint;
	y: bigint;
};

export function bigIntIDToBigintXY(position: bigint): CellBigIntXYPosition {
	const bn = BigInt(position);
	const x = BigInt.asIntN(32, bn);
	const y = BigInt.asIntN(32, bn >> 32n);
	return {x, y};
}

export function xyToXYID(x: number, y: number) {
	return '' + x + ',' + y;
}

export function IDToXY(id: string) {
	const [x, y] = id.split(',').map(Number);
	return {x, y};
}

export function xyToBigIntID(x: number, y: number): bigint {
	// const bn = (BigInt.asUintN(32, BigInt(x)) + BigInt.asUintN(32, BigInt(y))) << 32n;
	const bn = (x < 0 ? 2n ** 32n + BigInt(x) : BigInt(x)) + ((y < 0 ? 2n ** 32n + BigInt(y) : BigInt(y)) << 32n);
	return bn;
}

export class StratagemsContract {
	constructor(
		private state: StratagemsState,
		public MAX_LIFE: number,
	) {}

	_effectiveDelta(delta: number, enemyMap: number): number {
		let effectiveDelta = delta > 0 ? 1 : -1;
		// let effectiveDelta = delta != 0 ? delta : -1;
		if (effectiveDelta < 0 && enemyMap == 0) {
			effectiveDelta = 1;
			// effectiveDelta = 0;
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
					// if (life < MAX_LIFE) {
					const maxEpoch = MAX_LIFE - life + Math.floor((effectiveDelta - 1) / effectiveDelta);
					if (epochDelta > maxEpoch) {
						epochDelta = maxEpoch;
					}

					life += epochDelta * effectiveDelta;
					if (life > MAX_LIFE) {
						life = MAX_LIFE;
					}
					data.newLife = life;

					// we don not use the following: lastUpdate + epochDelta;
					//   because no state change is foreseen with no life increase
					data.epochUsed = epoch;
					// } else {
					// 	data.newLife = life;
					// 	data.epochUsed = lastUpdate;
					// }
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

					// since we need to track when the cell died, we upate lastUpdate only to
					//   the corresponding epoch where life reached 0
					data.epochUsed = lastUpdate + epochDelta;
				} else {
					data.newLife = life;

					// we don not use the following: lastUpdate + epochDelta;
					//   because no state change is foreseen with no life change
					data.epochUsed = epoch;
				}
			} else {
				data.newLife = life;

				// no change, no need to update lastUpdate either ?
				data.epochUsed = lastUpdate;
			}
		}

		return data;
	}

	getCellInMemory(position: bigint): ContractCell {
		const cell: ContractCell | null = this.state.cells[position.toString()];
		return {
			lastEpochUpdate: cell?.lastEpochUpdate || 0,
			color: cell?.color || Color.None,
			delta: cell?.delta || 0,
			enemyMap: cell?.enemyMap || 0,
			epochWhenTokenIsAdded: cell?.epochWhenTokenIsAdded || 0,
			life: cell?.life || 0,
			distribution: cell?.distribution || 0,
			stake: cell?.stake || 0,
			producingEpochs: cell?.producingEpochs || 0,
		};
	}

	getUpdatedCell(position: bigint, epoch: number) {
		const updatedCell = this.getCellInMemory(position);
		let justDied = false;
		const lastUpdate = updatedCell.lastEpochUpdate;
		const delta = updatedCell.delta;
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

	ownerOf(position: bigint) {
		return this.state.owners[position.toString()] || zeroAddress;
	}

	addPoints(owner: `0x${string}`, points: number) {
		let existingPoints = this.state.computedPoints[owner] || 0;
		this.state.computedPoints[owner] = existingPoints + points;
	}
	removePoints(owner: `0x${string}`, points: number) {
		let existingPoints = this.state.computedPoints[owner] || 0; // TODO error
		this.state.computedPoints[owner] = existingPoints - points;
	}

	updateCellFromNeighbor(
		position: bigint,
		cell: ContractCell,
		newLife: number,
		epoch: number,
		neighbourIndex: number,
		oldColor: Color,
		newColor: Color,
	): number {
		// const {x, y} = bigIntIDToXY(position);
		// console.log(`updateCellFromNeighbor ${x},${y}`, cell);
		let due = 0;
		if (cell.life > 0 && newLife == 0) {
			// we just died, we establish the distributionMap and counts
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
				// then newColor is different (see assert above)
				cell.enemyMap = cell.enemyMap | (1 << neighbourIndex);
				cell.delta -= 2;
			} else if (cell.color == newColor) {
				// then old color was different
				cell.delta += oldColor == Color.None ? 1 : 2;
				cell.enemyMap = cell.enemyMap & ((1 << neighbourIndex) ^ 0xff);
			} else if (oldColor == Color.None) {
				// if there were no oldCOlor and the newColor is not your (already checked in previous if clause)
				cell.delta -= 1;
				cell.enemyMap = cell.enemyMap | (1 << neighbourIndex);
			}
		}

		const owner = this.ownerOf(position);
		if (owner != zeroAddress && newLife > 0) {
			const newEffectiveDelta = this._effectiveDelta(cell.delta, cell.enemyMap);
			if (oldEffectiveDelta > 0 && newEffectiveDelta <= 0) {
				this.removePoints(owner, cell.stake); // GENERATOR.remove(owner, NUM_TOKENS_PER_GEMS * cell.stake);
			} else if (oldEffectiveDelta <= 0 && newEffectiveDelta > 0) {
				this.addPoints(owner, cell.stake); // GENERATOR.add(owner, NUM_TOKENS_PER_GEMS * cell.stake);
			}
		}

		if (oldEffectiveDelta > 0) {
			cell.producingEpochs += epoch - cell.lastEpochUpdate;
		}

		cell.lastEpochUpdate = epoch;
		cell.life = newLife;
		this.state.cells[position.toString()] = cell;
		// console.log(`AFTER updateCellFromNeighbor `, cell);
		// console.log(`AFTER updateCellFromNeighbor `, this.getUpdatedCell(position, epoch));
		return due;
	}

	updateCell(position: bigint, epoch: number, neighbourIndex: number, oldColor: Color, newColor: Color) {
		const data = {
			enemyOrFriend: 0,
			due: 0,
		};
		const cell = this.getCellInMemory(position);

		const lastUpdate = cell.lastEpochUpdate;
		const color = cell.color;
		if (color != Color.None) {
			data.enemyOrFriend = color == newColor ? 1 : -1;
		}

		if (lastUpdate >= 1 && color != Color.None) {
			// we only consider cell with color that are not dead
			if (cell.life > 0 && lastUpdate < epoch) {
				// of there is life to update we compute the new life
				const {newLife} = this.computeNewLife(lastUpdate, cell.enemyMap, cell.delta, cell.life, epoch);
				data.due = this.updateCellFromNeighbor(position, cell, newLife, epoch, neighbourIndex, oldColor, newColor);
			} else {
				data.due = this.updateCellFromNeighbor(position, cell, cell.life, epoch, neighbourIndex, oldColor, newColor);
			}
		}

		return data;
	}

	updateNeighbours(
		position: bigint,
		epoch: number,
		oldColor: Color,
		newColor: Color,
		distribution: number,
	): {newComputedDelta: number; newComputedEnemyMap: number; numDue: number} {
		const {x, y} = bigIntIDToXY(position);
		// console.log(`updating neighbors of ${x},${y}`);
		const data = {
			newComputedDelta: 0,
			newComputedEnemyMap: 0,
			numDue: 0,
		};

		{
			const upPosition = xyToBigIntID(x, y - 1);
			const {enemyOrFriend, due} = this.updateCell(upPosition, epoch, 2, oldColor, newColor);
			if (enemyOrFriend < 0) {
				data.newComputedEnemyMap = data.newComputedEnemyMap | 1;
			}
			data.numDue += due;
			// if (((distribution >> 4) & 4) == 4) {
			// owner -->
			// }
			data.newComputedDelta += enemyOrFriend;
		}

		{
			const leftPosition = xyToBigIntID(x - 1, y);
			const {enemyOrFriend, due} = this.updateCell(leftPosition, epoch, 3, oldColor, newColor);
			if (enemyOrFriend < 0) {
				data.newComputedEnemyMap = data.newComputedEnemyMap | 2;
			}
			data.numDue += due;
			// if (((distribution >> 4) & 8) == 8) {
			// owner -->
			// }
			data.newComputedDelta += enemyOrFriend;
		}

		{
			const downPosition = xyToBigIntID(x, y + 1);
			const {enemyOrFriend, due} = this.updateCell(downPosition, epoch, 0, oldColor, newColor);
			if (enemyOrFriend < 0) {
				data.newComputedEnemyMap = data.newComputedEnemyMap | 4;
			}
			data.numDue += due;
			// if (((distribution >> 4) & 1) == 1) {
			// owner -->
			// }
			data.newComputedDelta += enemyOrFriend;
		}

		{
			const rightPosition = xyToBigIntID(x + 1, y);
			const {enemyOrFriend, due} = this.updateCell(rightPosition, epoch, 1, oldColor, newColor);
			if (enemyOrFriend < 0) {
				data.newComputedEnemyMap = data.newComputedEnemyMap | 8;
			}
			data.numDue += due;
			// if (((distribution >> 4) & 2) == 2) {
			// owner -->
			// }
			data.newComputedDelta += enemyOrFriend;
		}

		return data;
	}

	propagate(move: ContractMove, epoch: number, color: Color, distribution: number) {
		const data = {
			newDelta: 0,
			newEnemyMap: 0,
		};

		const {
			newComputedDelta,
			newComputedEnemyMap,
			numDue,
			// ownersToPay
		} = this.updateNeighbours(move.position, epoch, color, move.color, distribution);

		// if (numDue > 0) {
		// 	_collectTransfer(
		// 		transferCollection,
		// 		TokenTransfer({to: payable(_ownerOf(move.position)), amount: (numDue * NUM_TOKENS_PER_GEMS) / 12})
		// 	);
		// }
		// for (uint8 i = 0; i < 4; i++) {
		// 	if (ownersToPay[i] != address(0)) {
		// 		_collectTransfer(
		// 			transferCollection,
		// 			TokenTransfer({to: payable(ownersToPay[i]), amount: (NUM_TOKENS_PER_GEMS / (distribution & 0x0f))})
		// 		);
		// 	}
		// }
		data.newDelta = newComputedDelta;
		data.newEnemyMap = newComputedEnemyMap;

		return data;
	}

	computeMove(player: `0x${string}`, epoch: number, moveAsInput: ContractMove) {
		const move = {...moveAsInput};
		const MAX_LIFE = this.MAX_LIFE;

		const {updatedCell: currentState, justDied} = this.getUpdatedCell(move.position, epoch);
		const oldEffectiveDelta = this._effectiveDelta(currentState.delta, currentState.enemyMap);

		const oldLife = currentState.life;

		// const {x, y} = bigIntIDToXY(move.position);
		// console.log(`COMPUTE_MOVE for ${x}, ${y}`, currentState);
		// console.log(this.state.cells[move.position.toString()]);

		// we might have distribution still to do
		let distribution = currentState.distribution;
		if (justDied) {
			// if we just died
			// we have to distribute to all
			distribution = (currentState.enemyMap << 4) + countBits(currentState.enemyMap);

			/// we are now dead for real
			currentState.lastEpochUpdate = 0;
		}

		// we then apply our move:

		// first we do some validity checks
		if (move.color == Color.None) {
			if (currentState.life != MAX_LIFE || this.ownerOf(move.position).toLowerCase() != player.toLowerCase()) {
				// invalid move
				// return (0, 0, NUM_TOKENS_PER_GEMS);
				return;
			}

			// _collectTransfer(transferCollection, TokenTransfer({to: payable(player), amount: NUM_TOKENS_PER_GEMS}));
		}
		// then we consider the case of collision and transform such move as Color Evil
		else if (currentState.epochWhenTokenIsAdded == epoch) {
			if (currentState.life != 0) {
				move.color = Color.Evil;
				// TODO Add further stake, or do we burn? or return?
			} else {
				// invalid move, on top of a MAX, that become None ?
				// return (0, 0, NUM_TOKENS_PER_GEMS);
				return;
			}
		}

		const {newDelta, newEnemyMap} = this.propagate(move, epoch, currentState.color, distribution);

		currentState.color = move.color;
		currentState.distribution = 0;
		if (!(this.ownerOf(move.position).toLowerCase() == player.toLowerCase() && currentState.life > 0)) {
			// we do not reset "epochWhenTokenIsAdded" when same player
			// this prevent other player to place color while it replace color
			currentState.epochWhenTokenIsAdded = epoch; // used to prevent overwriting, even Color.None
		}

		if (currentState.color == Color.None) {
			currentState.producingEpochs += epoch - currentState.lastEpochUpdate;
			currentState.life = 0;
			currentState.stake = 0;
			currentState.lastEpochUpdate = 0;
			currentState.delta = 0;
			currentState.enemyMap = 0;
			this.state.owners[move.position.toString()] = zeroAddress;
			if (oldEffectiveDelta > 0) {
				this.removePoints(player, 1); // GENERATOR.remove(player, NUM_TOKENS_PER_GEMS);
			}
			// tokensReturned = NUM_TOKENS_PER_GEMS;

			// console.log({color: currentState.color, currentState});
		} else {
			// tokensPlaced = NUM_TOKENS_PER_GEMS;

			currentState.enemyMap = newEnemyMap;

			if (currentState.color == Color.Evil && currentState.life != 0) {
				currentState.stake += 1;
				if (currentState.stake > 255) {
					// we cap it, losing stake there
					// TODO reevaluate
					currentState.stake = 255;
				}
			} else {
				currentState.stake = 1;
				currentState.producingEpochs = 0;
			}

			currentState.delta = newDelta;
			currentState.life = 2;
			currentState.lastEpochUpdate = epoch;

			const oldOwner = this.ownerOf(move.position);

			const newEffectiveDelta = this._effectiveDelta(currentState.delta, currentState.enemyMap);

			if (currentState.color == Color.Evil) {
				if (oldOwner != EVIL_OWNER_ADDRESS) {
					if (oldOwner == zeroAddress) {
						if (newEffectiveDelta > 0) {
							this.addPoints(EVIL_OWNER_ADDRESS, 1); // GENERATOR.add(0xffffffffffffffffffffffffffffffffffffffff, NUM_TOKENS_PER_GEMS);
						}
					} else {
						if (oldEffectiveDelta <= 0 && newEffectiveDelta > 0) {
							this.addPoints(EVIL_OWNER_ADDRESS, 2); // GENERATOR.add(0xffffffffffffffffffffffffffffffffffffffff, NUM_TOKENS_PER_GEMS * 2);
						} else if (oldEffectiveDelta > 0 && newEffectiveDelta <= 0) {
							this.removePoints(oldOwner, 1); // GENERATOR.remove(oldOwner, NUM_TOKENS_PER_GEMS);
						} else if (oldEffectiveDelta <= 0 && newEffectiveDelta <= 0) {
						} else if (oldEffectiveDelta > 0 && newEffectiveDelta > 0) {
							if (oldLife > 0) {
								this.removePoints(oldOwner, 1); // GENERATOR.remove(oldOwner, NUM_TOKENS_PER_GEMS);
								this.addPoints(EVIL_OWNER_ADDRESS, 2); // GENERATOR.add(0xffffffffffffffffffffffffffffffffffffffff, NUM_TOKENS_PER_GEMS * 2);
							} else {
								// SHOULD NOT REACH THERE
								console.error(`collision for black can only happen when tile are placed, so life > 0`);
								this.addPoints(EVIL_OWNER_ADDRESS, 1); // GENERATOR.add(0xffffffffffffffffffffffffffffffffffffffff, NUM_TOKENS_PER_GEMS);
							}
						}
					}
					this.state.owners[move.position.toString()] = EVIL_OWNER_ADDRESS;
				} else if (newEffectiveDelta > 0) {
					this.addPoints(EVIL_OWNER_ADDRESS, 1); // GENERATOR.add(0xffffffffffffffffffffffffffffffffffffffff, NUM_TOKENS_PER_GEMS);
				}
			} else {
				if (currentState.epochWhenTokenIsAdded != epoch && oldEffectiveDelta > 0) {
					// here we are dealing with a color replacement and so we need to consider points removal
					this.removePoints(player, 1); // GENERATOR.remove(player, NUM_TOKENS_PER_GEMS);
				}
				if (newEffectiveDelta > 0) {
					this.addPoints(player, 1); // GENERATOR.add(player, NUM_TOKENS_PER_GEMS);
				}
				this.state.owners[move.position.toString()] = player;
			}
		}

		this.state.cells[move.position.toString()] = currentState;

		// console.log(`AFTER`, currentState);
	}

	// ----------------------

	forceSimpleCells(epoch: number, cells: readonly ContractSimpleCell[]) {
		for (const simpleCell of cells) {
			const {delta, enemyMap} = this.updateNeighbosrDelta(simpleCell.position, simpleCell.color, epoch);

			this.state.cells[simpleCell.position.toString()] = {
				lastEpochUpdate: epoch,
				epochWhenTokenIsAdded: epoch,
				color: simpleCell.color,
				life: simpleCell.life,
				delta: delta,
				enemyMap: enemyMap,
				distribution: 0,
				stake: simpleCell.stake,
				producingEpochs: 0, // THIS IS FALSE but we go with it
			};
			this.state.owners[simpleCell.position.toString()] = simpleCell.owner;
			// console.log({
			// 	FORCE_FIRST: 'FORCE_FIRST',
			// 	position: bigIntIDToXY(simpleCell.position),
			// 	cell: this.getCellInMemory(simpleCell.position),
			// });
		}

		for (const simpleCell of cells) {
			const cell = this.getCellInMemory(simpleCell.position);

			// we act as if the token were added in previous epochs
			// this is so it does not affect the reveal phase
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

			this.state.cells[simpleCell.position.toString()] = newCell;
			// const {x, y} = bigIntIDToXY(simpleCell.position);
			// console.log(`forceSimpleCell ${x}, ${y}`, newCell);

			// console.log({
			// 	FORCE: 'FORCE',
			// 	position: bigIntIDToXY(simpleCell.position),
			// 	cell: this.getCellInMemory(simpleCell.position),
			// });
		}
	}

	updateNeighbosrDelta(center: bigint, color: Color, epoch: number): {delta: number; enemyMap: number} {
		const {x, y} = bigIntIDToXY(center);
		const data = {delta: 0, enemyMap: 0};

		{
			const upPosition = xyToBigIntID(x, y - 1);
			const cell = this.getCellInMemory(upPosition);
			if (cell.color != Color.None) {
				const enemyOrFriend = this.isEnemyOrFriend(color, cell.color);
				if (enemyOrFriend < 0) {
					data.enemyMap = data.enemyMap | 1;
				}
				data.delta += enemyOrFriend;
				this.updateCellFromNeighbor(upPosition, cell, cell.life, epoch, 2, Color.None, color);
			}
		}
		{
			const leftPosition = xyToBigIntID(x - 1, y);
			const cell = this.getCellInMemory(leftPosition);
			if (cell.color != Color.None) {
				const enemyOrFriend = this.isEnemyOrFriend(color, cell.color);
				if (enemyOrFriend < 0) {
					data.enemyMap = data.enemyMap | 2;
				}
				data.delta += enemyOrFriend;
				this.updateCellFromNeighbor(leftPosition, cell, cell.life, epoch, 3, Color.None, color);
			}
		}

		{
			const downPosition = xyToBigIntID(x, y + 1);
			const cell = this.getCellInMemory(downPosition);
			if (cell.color != Color.None) {
				const enemyOrFriend = this.isEnemyOrFriend(color, cell.color);
				if (enemyOrFriend < 0) {
					data.enemyMap = data.enemyMap | 4;
				}
				data.delta += enemyOrFriend;
				this.updateCellFromNeighbor(downPosition, cell, cell.life, epoch, 0, Color.None, color);
			}
		}
		{
			const rightPosition = xyToBigIntID(x + 1, y);
			const cell = this.getCellInMemory(rightPosition);
			if (cell.color != Color.None) {
				const enemyOrFriend = this.isEnemyOrFriend(color, cell.color);
				if (enemyOrFriend < 0) {
					data.enemyMap = data.enemyMap | 8;
				}
				data.delta += enemyOrFriend;
				this.updateCellFromNeighbor(rightPosition, cell, cell.life, epoch, 1, Color.None, color);
			}
		}
		return data;
	}

	poke(position: bigint, epoch: number) {
		const {updatedCell: currentState, justDied} = this.getUpdatedCell(position, epoch);

		// we might have distribution still to do
		let distribution = currentState.distribution;
		if (justDied) {
			// if we just died
			// we have to distribute to all
			distribution = (currentState.enemyMap << 4) + countBits(currentState.enemyMap);

			/// we are now dead for real
			currentState.lastEpochUpdate = 0;
		}

		const {
			numDue,
			// ownersToPay
		} = this.updateNeighbours(position, epoch, currentState.color, currentState.color, distribution);

		// if (numDue > 0) {
		//     _collectTransfer(
		//         transferCollection,
		//         TokenTransfer({to: payable(_ownerOf(position)), amount: numDue * NUM_TOKENS_PER_GEMS})
		//     );
		// }

		// for (uint8 i = 0; i < 4; i++) {
		//     if (ownersToPay[i] != address(0)) {
		//         _collectTransfer(
		//             transferCollection,
		//             TokenTransfer({to: payable(ownersToPay[i]), amount: NUM_TOKENS_PER_GEMS})
		//         );
		//     }
		// }

		currentState.distribution = 0;
		this.state.cells[position.toString()] = currentState;
	}

	isEnemyOrFriend(a: Color, b: Color) {
		if (a != Color.None && b != Color.None) {
			return a == b ? 1 : -1;
		}
		return 0;
	}
}
