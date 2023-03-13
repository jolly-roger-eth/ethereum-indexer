export type NFT = {
	id: `0x${string}`;
	tokenAddress: `0x${string}`;
	tokenID: string;
};

export type Data = {
	nfts: NFT[];
};
