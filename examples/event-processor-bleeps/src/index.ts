import {fromJSProcessor, JSProcessor} from 'ethereum-indexer-js-processor';

import eip721 from './eip721';
import {Data, Bleep} from './types';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const BleepsEventProcessor: JSProcessor<typeof eip721, Data> = {
	construct(): Data {
		return {
			bleepers: [],
			bleeps: [],
		};
	},
	onTransfer(data, event) {
		const to = event.args.to;

		const tokenID = event.args.id.toString();

		let bleep: Bleep;
		let index = data.bleeps.findIndex((v) => v.tokenID === tokenID);
		if (index !== -1) {
			bleep = data.bleeps[index];
		}

		if (!bleep) {
			bleep = {
				tokenID,
				owner: to,
			};
			data.bleeps.push(bleep);
		} else {
			if (to === ZERO_ADDRESS) {
				data.bleeps.splice(index, 1);
				return;
			} else {
				bleep.owner = to;
			}
		}
	},
};

export const createProcessor = fromJSProcessor(BleepsEventProcessor);

export const contractsData = [
	{
		chainId: '1',
		abi: eip721,
		address: '0x9d27527Ada2CF29fBDAB2973cfa243845a08Bd3F',
		startBlock: 13757521,
	},
] as const;
