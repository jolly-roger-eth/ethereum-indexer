export type Voidrunner = {
	address: string;
};

export type Spaceship = {
	tokenID: string;
	owner: string;
};

export type Data = {
	spaceships: Spaceship[];
	voidrunners: Voidrunner[];
};
