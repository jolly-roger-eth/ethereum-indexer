import {
	EventWithId,
	fromSingleJSONEventProcessorObject,
	SingleJSONEventProcessorObject,
} from 'ethereum-indexer-json-processor';

import {logs} from 'named-logs';

import OuterSpace from './abis/OuterSpace';
import {Data, Planet, Player} from './types/db';
import {ExitComplete, FleetArrived, FleetSent, PlanetExit, PlanetStake, PlanetTransfer} from './types/events';

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

const ConquestEventProcessor: SingleJSONEventProcessorObject<typeof OuterSpace, Data> = {
	async setup(json: Data): Promise<void> {
		json.space = {
			address: '', // TODO
			expansionDelta: 0,
			maxX: 0,
			maxY: 0,
			minX: 0,
			minY: 0,
		};
		json.players = {};
		json.planets = {};
		json.fleets = {};
		// namedLogger.info(`setup complete!`);
	},
	onPlanetStake(data, event) {
		getOrCreatePlayer(data, event.args.acquirer);
		const planet = getOrCreatePlanet(data, event.args.location.toString());
		planet.owner = event.args.acquirer;
	},
	onPlanetTransfer(data, event) {
		// getPlayer(data, event.args.previousOwner);
		getOrCreatePlayer(data, event.args.newOwner);
		const planet = getPlanet(data, event.args.location.toString());
		planet.owner = event.args.newOwner;
	},
	onPlanetExit(data, event) {
		// getPlayer(data, event.args.owner);
		const planet = getPlanet(data, event.args.location.toString());
		planet.exitTime = event.blockNumber; // TODO block timestamp
	},
	// TODO
	// onTravelingUpkeepRefund(data: Data, event: TravelingUpkeepRefund) {

	// },
	onExitComplete(data, event) {
		const planet = getPlanet(data, event.args.location.toString());
		planet.exitTime = 0;
		planet.owner = undefined;
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
		if (event.args.won) {
			planet.owner = event.args.fleetOwner;
			planet.exitTime = 0;
		}
	},
};

export const processor = fromSingleJSONEventProcessorObject(() => ConquestEventProcessor);

const contractsDataonGnosis = [
	{
		eventsABI: OuterSpace,
		address: '0x7ed5118E042F22DA546C9aaA9540D515A6F776E9',
		startBlock: 21704746,
	},
];

export const contractsDataPerChain = {100: contractsDataonGnosis};
