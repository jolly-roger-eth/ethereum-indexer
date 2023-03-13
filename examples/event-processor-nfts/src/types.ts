export type NFT = {
	tokenAddress: `0x${string}`;
	tokenID: string;
};

export type Data = {
	nfts: NFT[];
};
