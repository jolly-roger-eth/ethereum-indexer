import {JSProcessor, fromJSProcessor} from 'ethereum-indexer-js-processor';

import {logs} from 'named-logs';

import OuterSpace from './abis/OuterSpace';
import erc20 from './abis/erc20';
import {Data, Planet, Player, StakedPlanet} from './types/db';

const namedLogger = logs('ConquestEventProcessor');

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const leftMostBit = BigInt('0x80000000000000000000000000000000');
const bn128 = BigInt('0x100000000000000000000000000000000');
function locationToXYID(location: string) {
	// const bn = BigInt(location);
	// namedLogger.info(bn.toString(16) + '\n' + bn.toString(2));
	// const x = BigInt.asUintN(128, bn);
	// namedLogger.info(x.toString(16) + '\n' + x.toString(2));
	// // namedLogger.info(x.toString(16));
	// const y = bn >> 128n;
	// namedLogger.info(y.toString(16) + '\n' + y.toString(2));
	// // namedLogger.info(y.toString(16));

	// const rx = x >= leftMostBit ? -(bn128 - x) : x;
	// namedLogger.info(rx.toString(16) + '\n' + rx.toString(2));
	// const ry = y >= leftMostBit ? -(bn128 - y) : y;
	// namedLogger.info(ry.toString(16) + '\n' + ry.toString(2));

	// namedLogger.info('' + rx + ',' + ry);
	// return '' + rx + ',' + ry;

	const bn = BigInt(location);
	const x = BigInt.asUintN(128, bn);
	const y = bn >> 128n;
	const rx = x >= leftMostBit ? -(bn128 - x) : x;
	const ry = y >= leftMostBit ? -(bn128 - y) : y;
	return '' + rx + ',' + ry;
}

function getOrCreatePlanet(data: Data, location: string): Planet {
	const planetID = locationToXYID(location);
	// namedLogger.info(`PlanetStaked: ${planetID}`);
	let planet = data.planets[planetID];
	if (!planet) {
		planet = {
			location,
			owner: undefined,
			exitTime: 0,
			numSpaceships: 0,
			travelingUpkeep: 0,
			overflow: 0,
			active: false,
			lastUpdated: 0,
			firstAcquired: 0,
			lastAcquired: 0,
			flagTime: 0,
			stakeDeposited: 0n,
		};
		data.planets[planetID] = planet;
	}
	return planet;
}

function getOrCreateStakedPlanet(data: Data, location: string): StakedPlanet {
	const planetID = locationToXYID(location);
	// namedLogger.info(`PlanetStaked: ${planetID}`);
	let planet = data.stakedPlanets[planetID];
	if (!planet) {
		planet = {
			location,
			owner: undefined,
			flagTime: 0,
			stakeDeposited: 0n,
		};
		data.stakedPlanets[planetID] = planet;
	}
	return planet;
}

function getStakedPlanet(data: Data, location: string): StakedPlanet {
	const planetID = locationToXYID(location);
	const planet = data.stakedPlanets[planetID];
	if (!planet) {
		throw new Error(`StakedPlanet expected to exist`);
	}
	return planet;
}

function getPlanet(data: Data, location: string): Planet {
	const planetID = locationToXYID(location);
	const planet = data.planets[planetID];
	if (!planet) {
		throw new Error(`Planet expected to exist`);
	}
	return planet;
}

function getOrCreatePlayer(data: Data, address: string): Player {
	const playerID = address;
	// namedLogger.info(`PlanetStaked: ${planetID}`);
	let player = data.players[playerID];
	if (!player) {
		player = {
			address,
			totalStaked: 0n,
			currentStake: 0n,
			totalCollected: 0n,
			playTokenBalance: 0n,
			freePlayTokenBalance: 0n,
			tokenToWithdraw: 0n,
		};
		data.players[playerID] = player;
	}
	return player;
}

function getPlayer(data: Data, address: string): Player {
	const playerID = address;
	// namedLogger.info(`PlanetStaked: ${planetID}`);
	let player = data.players[playerID];
	if (!player) {
		throw new Error(`Player ${address} expected to exits already`);
	}
	return player;
}

const ConquestEventProcessor: JSProcessor<typeof OuterSpace, Data> = {
	construct(): Data {
		return {
			totalStakeOverTime: 0n,
			totalFreePlayTransferedInOverTime: 0n,
			totalPlayTransferedInOverTime: 0n,
			space: {
				address: '', // TODO
				expansionDelta: 0,
				maxX: 0,
				maxY: 0,
				minX: 0,
				minY: 0,
			},
			players: {},
			stakedPlanets: {},
			planets: {},
			fleets: {},
		};
	},
	onPlanetStake(data, event) {
		const player = getOrCreatePlayer(data, event.args.acquirer);
		const planet = getOrCreatePlanet(data, event.args.location.toString());
		planet.active = true;
		planet.owner = event.args.acquirer;
		player.currentStake += event.args.stake;
		planet.stakeDeposited = event.args.stake;

		const stakedPlanet = getOrCreateStakedPlanet(data, event.args.location.toString());
		stakedPlanet.owner = event.args.acquirer;
		stakedPlanet.stakeDeposited = event.args.stake;
		stakedPlanet.flagTime = event.args.freegift ? 1 : 0;

		data.totalStakeOverTime += event.args.stake;
	},
	onTransfer(data, event) {
		if (event.address.toLowerCase() === '0x8d82B1900bc77fACdf6f2209869E4f816E4fbcB2'.toLowerCase()) {
			// free play token
			if (event.args.to.toLowerCase() === '0x7ed5118E042F22DA546C9aaA9540D515A6F776E9'.toLowerCase()) {
				data.totalFreePlayTransferedInOverTime += (event.args as any).amount;
			}
			if (
				event.args.from.toLowerCase() === '0x7ed5118E042F22DA546C9aaA9540D515A6F776E9'.toLowerCase() &&
				event.args.to.toLowerCase() === '0x0000000000000000000000000000000000000000'.toLowerCase()
			) {
				data.totalFreePlayTransferedInOverTime -= (event.args as any).amount;
			}
		} else if (event.address.toLowerCase() === '0x1874F6326eEbcCe664410a93a5217741a977D14A'.toLowerCase()) {
			// play token
			if (event.args.to.toLowerCase() === '0x7ed5118E042F22DA546C9aaA9540D515A6F776E9'.toLowerCase()) {
				data.totalPlayTransferedInOverTime += (event.args as any).amount;
			}
		} else if (event.address.toLowerCase() === '0x7ed5118E042F22DA546C9aaA9540D515A6F776E9'.toLowerCase()) {
			// erc721
		}
	},
	onPlanetTransfer(data, event) {
		// TODO const previousOwner = getPlayer(data, event.args.previousOwner);

		const planet = getPlanet(data, event.args.location.toString());
		planet.owner = event.args.newOwner;
		if (planet.active && planet.exitTime == 0) {
			const previousOwner = getOrCreatePlayer(data, event.args.previousOwner);
			const newOwner = getOrCreatePlayer(data, event.args.newOwner);
			previousOwner.currentStake -= planet.stakeDeposited;
			// TODO remove
			if (previousOwner.currentStake == 0n) {
				delete data.players[event.args.previousOwner];
			}
			newOwner.currentStake += planet.stakeDeposited;
		}

		if (planet.active) {
			const stakedPlanet = getStakedPlanet(data, event.args.location.toString());
			stakedPlanet.owner = event.args.newOwner;
		}
	},
	onPlanetExit(data, event) {
		const player = getPlayer(data, event.args.owner);
		const planet = getPlanet(data, event.args.location.toString());
		planet.exitTime = event.blockNumber; // TODO block timestamp
		player.currentStake -= planet.stakeDeposited;
		// TODO remove
		if (player.currentStake == 0n) {
			delete data.players[event.args.owner];
		}

		const stakedPlanet = getStakedPlanet(data, event.args.location.toString());
		stakedPlanet.exitTime = event.blockNumber;
	},
	// TODO
	// onTravelingUpkeepRefund(data: Data, event: TravelingUpkeepRefund) {

	// },
	onExitComplete(data, event) {
		const planet = getPlanet(data, event.args.location.toString());
		planet.exitTime = 0;
		planet.active = false;
		planet.stakeDeposited = 0n;
		planet.owner = undefined;
		const stakedPlanet = getStakedPlanet(data, event.args.location.toString());
		if (!stakedPlanet.exitTime || stakedPlanet.exitTime <= 0) {
			throw new Error(`no exitTime for ExitComplete`);
		}
		delete data.stakedPlanets[event.args.location.toString()];
	},
	onFleetSent(data, event) {
		data.fleets[event.args.fleet.toString()] = {
			id: event.args.fleet.toString(),
			owner: event.args.fleetOwner,
			sender: event.args.fleetSender,
			operator: event.args.fleetSender, // TODO fix using tx data
			launchTime: event.blockNumber, // TODO fix using block timestamp
			from: event.args.from.toString(),
			quantity: event.args.quantity,
			resolved: false,
			sendTransaction: event.transactionHash,
		};
	},
	onFleetArrived(data, event) {
		const planet = getOrCreatePlanet(data, event.args.destination.toString());

		// namedLogger.info(event.args.data);

		const fleet = data.fleets[event.args.fleet.toString()];
		fleet.resolveTransaction = event.transactionHash;
		// TODO result

		if (planet.active && event.args.won) {
			const stakedPlanet = getStakedPlanet(data, event.args.destination.toString());
			stakedPlanet.owner = event.args.fleetOwner;
			stakedPlanet.exitTime = 0;
		}

		if (planet.active && event.args.won) {
			planet.owner = event.args.fleetOwner;
			if (planet.exitTime != 0) {
				planet.exitTime = 0;
				const winner = getOrCreatePlayer(data, event.args.fleetOwner);
				winner.currentStake += planet.stakeDeposited;
			} else {
				const loser = getOrCreatePlayer(data, event.args.destinationOwner);
				loser.currentStake -= planet.stakeDeposited;
				// TODO remove
				if (loser.currentStake == 0n) {
					delete data.players[event.args.destinationOwner];
				}
				const winner = getOrCreatePlayer(data, event.args.fleetOwner);
				winner.currentStake += planet.stakeDeposited;
			}
		}
	},
};

export const createProcessor = fromJSProcessor(ConquestEventProcessor);

const contractsDataonGnosis = [
	{
		abi: OuterSpace,
		address: '0x7ed5118E042F22DA546C9aaA9540D515A6F776E9',
		startBlock: 21704746,
	},
	{
		abi: erc20,
		address: '0x8d82B1900bc77fACdf6f2209869E4f816E4fbcB2', // free play token
		startBlock: 21704746,
	},
	{
		abi: erc20,
		address: '0x1874F6326eEbcCe664410a93a5217741a977D14A', // play token
		startBlock: 21704746,
	},
] as const;

export const contractsDataPerChain = {100: contractsDataonGnosis} as const;
