import {
	EventWithId,
	fromSingleJSONEventProcessorObject,
	SingleJSONEventProcessorObject
} from 'ethereum-indexer-json-processor';

import {logs} from 'named-logs';

import OuterSpace from './abis/OuterSpace.json';
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
			exiting: false
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
			address
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

const ConquestEventProcessor: SingleJSONEventProcessorObject<Data> = {
	async setup(json: Data): Promise<void> {
		json.players = {};
		json.planets = {};
		json.fleets = {};
		// namedLogger.info(`setup complete!`);
	},
	onPlanetStake(data: Data, event: PlanetStake) {
		getOrCreatePlayer(data, event.args.acquirer);
		const planet = getOrCreatePlanet(data, event.args.location);
		planet.owner = event.args.acquirer;
	},
	onPlanetTransfer(data: Data, event: PlanetTransfer) {
		// getPlayer(data, event.args.previousOwner);
		getOrCreatePlayer(data, event.args.newOwner);
		const planet = getPlanet(data, event.args.location);
		planet.owner = event.args.newOwner;
	},
	onPlanetExit(data: Data, event: PlanetExit) {
		// getPlayer(data, event.args.owner);
		const planet = getPlanet(data, event.args.location);
		planet.exiting = true;
	},
	// TODO
	// onTravelingUpkeepRefund(data: Data, event: TravelingUpkeepRefund) {

	// },
	onExitComplete(data: Data, event: ExitComplete) {
		const planet = getPlanet(data, event.args.location);
		planet.exiting = false;
		planet.owner = undefined;
	},
	onFleetSent(data: Data, event: FleetSent) {
		data.fleets[event.args.fleet] = {id: event.args.fleet, arrived: false};
	},
	onFleetArrived(data: Data, event: FleetArrived) {
		const planet = getOrCreatePlanet(data, event.args.destination);

		data.fleets[event.args.fleet].arrived = true;
		if (event.args.won) {
			planet.owner = event.args.fleetOwner;
			planet.exiting = false;
		}
	}
};

export const processor = fromSingleJSONEventProcessorObject(() => ConquestEventProcessor);

const contractsDataonGnosis = [
	{
		eventsABI: OuterSpace,
		address: '0x7ed5118E042F22DA546C9aaA9540D515A6F776E9',
		startBlock: 21704746
	}
];

export const contractsDataPerChain = {100: contractsDataonGnosis};
