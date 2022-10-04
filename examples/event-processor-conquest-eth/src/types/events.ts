import {EventWithId} from 'ethereum-indexer-json-processor';

export type FleetSent = EventWithId<{
	fleet: string;
	from: string;
	fleetSender: string;
	fleetOwner: string;
	quantity: number;

	// lastUpdated = event.block.timestamp; // TODO
	newNumSpaceships: number;
	newTravelingUpkeep: number;
	newOverflow: number;
}>;

export type FleetArrived = EventWithId<{
	fleet: string;
	destination: string;
	fleetOwner: string;
	destinationOwner: string;
	won: boolean;
	gift: boolean;

	data: string; // TODO

	// lastUpdated = event.block.timestamp; // TODO
	newNumSpaceships: number;
	newTravelingUpkeep: number;
	newOverflow: number;
}>;

export type PlanetStake = EventWithId<{
	location: string;
	acquirer: string;
	stake: string;
	freegift: boolean;

	// lastUpdated = event.block.timestamp; // TODO
	numSpaceships: number;
	travelingUpkeep: number;
	overflow: number;
}>;

export type PlanetTransfer = EventWithId<{
	location: string;
	previousOwner: string;
	newOwner: string;

	// lastUpdated = event.block.timestamp; // TODO
	newNumSpaceships: number;
	newTravelingUpkeep: number;
	newOverflow: number;
}>;

export type PlanetExit = EventWithId<{
	owner: string;
	location: string;
}>;

export type ExitComplete = EventWithId<{
	owner: string;
	stake: string;
	location: string;
}>;
