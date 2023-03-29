export type Bleeper = {
	address: string;
};

export type Bleep = {
	tokenID: string;
	owner: string;
};

export type Data = {
	bleeps: Bleep[];
	bleepers: Bleeper[];
};
