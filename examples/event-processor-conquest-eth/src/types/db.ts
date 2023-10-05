export type Planet = {
	location: string;
	owner?: string;

	numSpaceships: number;
	travelingUpkeep: number;
	overflow: number;
	active: boolean;
	lastUpdated: number;
	firstAcquired: number;
	lastAcquired: number;
	exitTime: number;
	flagTime: number;

	stakeDeposited: bigint;
	// currentExit: PlanetExitEvent
};

export type StakedPlanet = {
	location: string;
	owner: string;
	flagTime: number;
	stakeDeposited: bigint;
	exitTime: number;
};

export type Player = {
	address: string;
	totalStaked: bigint;
	currentStake: bigint;
	totalCollected: bigint;
	playTokenBalance: bigint;
	freePlayTokenBalance: bigint;
	tokenToWithdraw: bigint;
};

export type Fleet = {
	id: string;
	owner: string;
	sender: string;
	operator: string;
	launchTime: number;
	from: string;
	quantity: number;
	resolved: boolean;
	sendTransaction: string;
	resolveTransaction?: string;
	to?: string;
	destinationOwner?: string;
	gift?: boolean;
	fleetLoss?: number;
	planetLoss?: number;
	inFlightFleetLoss?: number;
	inFlightPlanetLoss?: number;
	won?: boolean;
};

export type Data = {
	totalStakeOverTime: bigint;
	currentStake: bigint;
	currentStakeMinusPendingExit: bigint;
	totalFreePlayTransferedInOverTime: bigint;
	totalPlayTransferedInOverTime: bigint;
	space: Space;
	stakedPlanets: {[location: string]: StakedPlanet};
	planets: {[location: string]: Planet};
	players: {[address: string]: Player};
	fleets: {[fleetId: string]: Fleet};
	playersWithWithdrawalNeeded: {[address: string]: {freeplay: bigint; play: bigint}};
};

export type Space = {
	address: string;
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;

	expansionDelta: number;

	// totalStaked: BigInt!
	// currentStake: BigInt!

	// numPlanetsStaked: BigInt!
	// numPlanetsStakedOnce: BigInt!

	// numFleetsLaunched: BigInt!
	// numFleetsResolved: BigInt!

	// numPlanetsExitFinalized: BigInt!
	// numPlanetsWithExit: BigInt!
};
