import {fromSingleJSONEventProcessorObject, SingleJSONEventProcessorObject} from 'ethereum-indexer-json-processor';
import eip721 from './eip721';
import {Data, NFT} from './types';

export * from './types';

// we export a factory function called processor
// the helper "fromSingleEventProcessorObject" will transform the single event processor...
// ... into the processor type expected by ethereum-indexer
export const processor = fromSingleJSONEventProcessorObject((config: {account: `0x${string}`}) => {
	const NFTEventProcessor: SingleJSONEventProcessorObject<typeof eip721, Data> = {
		async setup(json: Data): Promise<void> {
			json.nfts = [];
		},
		onTransfer(data, event) {
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
	return NFTEventProcessor;
});

// we expose contractsData as generic to be used on any chain
export const contractsData = {
	abi: eip721,
} as const;
