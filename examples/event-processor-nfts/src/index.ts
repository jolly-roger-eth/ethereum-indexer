import {fromJSProcessor, JSProcessor} from 'ethereum-indexer-json-processor';
import eip721 from './eip721';
import {Data, NFT} from './types';

const NFTEventProcessor: JSProcessor<typeof eip721, Data, {account: `0x${string}`}> = {
	construct(): Data {
		return {nfts: []};
	},
	onTransfer(data, event, config) {
		const to = event.args.to;
		const tokenID = event.args.id.toString();

		let nft: NFT;
		let nftIndex = data.nfts.findIndex((v) => v.tokenAddress === event.address && v.tokenID === tokenID);
		if (nftIndex !== -1) {
			nft = data.nfts[nftIndex];
		}

		if (!nft) {
			// TODO agree on format
			if (to.toLowerCase() === config.account.toLowerCase()) {
				nft = {
					tokenID,
					tokenAddress: event.address,
				};
				data.nfts.push(nft);
			}
		} else {
			if (to.toLowerCase() !== config.account.toLowerCase()) {
				data.nfts.splice(nftIndex, 1);
				return;
			}
		}
	},
};

// we export the processor as factory function
export const createProcessor = fromJSProcessor(NFTEventProcessor);

// we expose contractsData as generic to be used on any chain
export const contractsData = {
	abi: eip721,
} as const;

// export the types used so that it can be reused in the app using the indexer
export * from './types';
