import {fromJSProcessor, JSProcessor} from 'ethereum-indexer-json-processor';

import eip721 from './eip721';
import {Data, Spaceship} from './types';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const VoidrunnerEventProcessor: JSProcessor<typeof eip721, Data> = {
	construct(): Data {
		return {
			voidrunners: [],
			spaceships: [],
		};
	},
	onTransfer(data, event) {
		const to = event.args.to;

		const tokenID = event.args.id.toString();

		let spaceship: Spaceship;
		let spaceshipIndex = data.spaceships.findIndex((v) => v.tokenID === tokenID);
		if (spaceshipIndex !== -1) {
			spaceship = data.spaceships[spaceshipIndex];
		}

		if (!spaceship) {
			spaceship = {
				tokenID,
				owner: to,
			};
			data.spaceships.push(spaceship);
		} else {
			if (to === ZERO_ADDRESS) {
				data.spaceships.splice(spaceshipIndex, 1);
				return;
			} else {
				spaceship.owner = to;
			}
		}
	},
};

export const processor = fromJSProcessor(VoidrunnerEventProcessor);

// we expose contractsData as generic to be used on any chain
export const contractsData = [
	{
		chainId: '1',
		abi: eip721,
		address: '0x4658e9c5e1e05280e3708741aba63b7ff4e81055',
		startBlock: 14953977,
	},
] as const;

// we also expose a object keyed by chainId
// export const contractsDataPerChain = { 1: contractsData };
