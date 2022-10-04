export type Planet = {
	location: string;
	owner?: string;
	exiting: boolean;
};

export type Player = {
	address: string;
};

export type Fleet = {
	id: string;
	arrived: boolean; // TODO timestamp ?
};

export type Data = {
	planets: {[location: string]: Planet};
	players: {[address: string]: Player};
	fleets: {[fleetId: string]: Fleet};
};
