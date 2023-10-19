export type Account = {
	address: string;
	amount: bigint;
};

export type Data = {
	accounts: Account[];
};
