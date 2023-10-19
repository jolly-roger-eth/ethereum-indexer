import {fromJSProcessor, JSProcessor} from 'ethereum-indexer-js-processor';

import eip20 from './eip20';
import {Account, Data} from './types';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const FPLAYEventProcessor: JSProcessor<typeof eip20, Data> = {
	construct(): Data {
		return {
			accounts: [],
		};
	},
	onTransfer(data, event) {
		const {to, from, amount} = event.args;

		console.log({to, from, amount, blockNumber: event.blockNumber, address: event.address, tx: event.transactionHash});

		if (from.toLowerCase() !== ZERO_ADDRESS) {
			let fromAccount: Account;
			let fromIndex = data.accounts.findIndex((v) => v.address === from);
			if (fromIndex !== -1) {
				fromAccount = data.accounts[fromIndex];
				const newAmount = fromAccount.amount - amount;
				fromAccount.amount = newAmount;
				if (fromAccount.amount === 0n) {
					data.accounts.splice(fromIndex, 1);
				} else if (fromAccount.amount < 0n) {
					throw new Error(`impossible, not enough balance`);
				}
			} else {
				if (amount > 0n) {
					throw new Error(`impossible, account not exist`);
				}
			}
		}

		if (to.toLowerCase() !== ZERO_ADDRESS) {
			let toAccount: Account;
			let toIndex = data.accounts.findIndex((v) => v.address === to);
			if (toIndex !== -1) {
				toAccount = data.accounts[toIndex];
				toAccount.amount = toAccount.amount + amount;
			} else {
				if (amount > 0n) {
					toAccount = {
						address: to,
						amount,
					};
					data.accounts.push(toAccount);
				}
			}
		}
	},
};

export const createProcessor = fromJSProcessor(FPLAYEventProcessor);

export const contractsDataPerChain = {
	'100': [
		{
			abi: eip20,
			address: '0x8d82b1900bc77facdf6f2209869e4f816e4fbcb2',
			startBlock: 21704726,
		},
	],
} as const;
