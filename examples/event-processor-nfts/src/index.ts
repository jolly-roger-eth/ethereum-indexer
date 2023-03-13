import {fromSingleJSONEventProcessorObject, SingleJSONEventProcessorObject} from 'ethereum-indexer-json-processor';

import {logs} from 'named-logs';

import eip721 from './eip721';
import {Data, NFT} from './types';

const namedLogger = logs('NFTEventProcessor');

// we export a factory function called processor
// the helper "fromSingleEventProcessorObject" will transform the single event processor...
// ... into the processor type expected by ethereum-indexer-server
export const processor = fromSingleJSONEventProcessorObject((config: {account: `0x${string}`}) => {
	const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

	const NFTEventProcessor: SingleJSONEventProcessorObject<typeof eip721, Data> = {
		async setup(json: Data): Promise<void> {
			json.nfts = [];
			// namedLogger.info(`setup complete!`);
		},
		onTransfer(data, event) {
			// namedLogger.info(`onTransfer...`);

			const to = event.args.to;

			const tokenID = event.args.id.toString();

			const id = (event.address + '_' + tokenID) as `0x${string}`;

			let nft: NFT;
			let nftIndex = data.nfts.findIndex((v) => v.id === id);
			if (nftIndex !== -1) {
				nft = data.nfts[nftIndex];
			}

			if (!nft) {
				// TODO agree on format
				if (to.toLowerCase() === config.account.toLowerCase()) {
					// namedLogger.info(`new token ${tokenID}: with owner: ${to}`);
					nft = {
						id,
						tokenID,
						tokenAddress: event.address,
					};
					data.nfts.push(nft);
				}
			} else {
				// namedLogger.info(`token ${tokenID} already exists`);
				if (to.toLowerCase() !== config.account.toLowerCase()) {
					// namedLogger.info(`deleting it...`);
					data.nfts.splice(nftIndex, 1);
					return;
				}
			}

			// namedLogger.info(JSON.stringify(data, null, 2));
		},
	};
	return NFTEventProcessor;
});

// we expose contractsData as generic to be used on any chain
export const contractsData = {
	chainId: '1',
	abi: eip721,
} as const;

// we also expose a object keyed by chainId
// export const contractsDataPerChain = { 1: contractsData };
