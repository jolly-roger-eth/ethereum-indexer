import type {JSProcessor} from '@etherfold/js-processor';
import {fromJSProcessor} from '@etherfold/js-processor';

import eip721 from './eip721.js';
import type {Data, Bleep} from './types.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const BleepsEventProcessor: JSProcessor<typeof eip721, Data> = {
	// REQUIRED: the identity of this processor's logic. The indexer discards state computed by a
	// previous version by comparing it, so bump it whenever a handler changes. Generating it (as
	// `event-processor-nfts` does, from a hash of the built file) is better than remembering to.
	version: '1.0.0',
	construct(): Data {
		return {
			bleepers: [],
			bleeps: [],
		};
	},
	onTransfer(data, event) {
		const to = event.args.to;

		const tokenID = event.args.id.toString();

		let bleep: Bleep | undefined;
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
