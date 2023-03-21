import {fromJSProcessor, JSProcessor} from 'ethereum-indexer-js-processor';
import eip721 from './eip721';
import {Data, NFT} from './types';

// we just need to define as a JSProcessor type to get type safety automatically added
// including event argument types
// the first generic parameter need to be the abi of all contracts merged
// can use MergedABIs if needed like MergedABIS<eip721, eip1155>
// the second generic parameter is optional and allow you to configure the processor
// in this case, we configure it to only care about a certain account.
// this is used in combination with a specific log filter to only get NFT from that particular account
// that filter is passed in to the indexer at initialisation time, see web-demo
const NFTEventProcessor: JSProcessor<typeof eip721, Data, {account: `0x${string}`}> = {
	version: '__VERSION_HASH__',
	construct(): Data {
		return {nfts: []};
	},
	onTransfer(data, event, config) {
		const to = event.args.to;
		const tokenID = event.args.id.toString();

		let nft: NFT | undefined;
		let nftIndex = data.nfts.findIndex((v) => v.tokenAddress === event.address && v.tokenID === tokenID);
		if (nftIndex !== -1) {
			nft = data.nfts[nftIndex];
		}

		if (!nft) {
			if (to === config.account) {
				nft = {
					tokenID,
					tokenAddress: event.address,
				};
				data.nfts.push(nft);
				// data.nfts.push({tokenID: tokenID + `1`, tokenAddress: event.address});
				// never add
			}
		} else {
			if (to !== config.account) {
				data.nfts.splice(nftIndex, 1);
				return;
			}
		}
	},
};

// we export the processor as factory function expected by ethereum-indexer-browser
export const createProcessor = fromJSProcessor(NFTEventProcessor);

// we expose contractsData as generic to be used on any chain
export const contractsData = {
	abi: eip721,
} as const;

// export the types used so that it can be reused in the app using the indexer
export * from './types';
