import type {EIP1193Provider} from 'eip-1193';
import {writable} from 'svelte/store';
import type {Chain} from 'viem';
import * as chains from 'viem/chains';
import {queuedProvider} from './utils';

function getConfigFromChainId(chainId: string): Chain {
	const chainIdAsNumber = parseInt(chainId);
	for (const key of Object.keys(chains)) {
		const chain = chains[key];
		if (chain.id === chainIdAsNumber) {
			return chain;
		}
	}
}

export type Web3Connection = {state: 'Idle' | 'Loading' | 'SwithingChain' | 'Ready'; error?: string};
const store = writable<Web3Connection>({
	state: 'Idle',
});

function setError(message: string) {
	store.set({state: 'Idle', error: message});
	throw new Error(message);
}

export type ActiveConnection = {ethereum: EIP1193Provider; chainId: string; accounts: `0x${string}`[]};

async function start(
	expectedChainId: string | undefined,
	accountsToUse: boolean | `0x${string}`
): Promise<ActiveConnection> {
	store.set({state: 'Loading'});
	try {
		const windowEthereum: EIP1193Provider = (window as any).ethereum;

		const ethereum = queuedProvider(windowEthereum);

		if (ethereum) {
			const chainIdAsHex = await ethereum.request({method: 'eth_chainId'});
			const chainId = parseInt(chainIdAsHex.slice(2), 16).toString();
			if (expectedChainId) {
				const expectedChainIdAsHex = `0x${parseInt(expectedChainId).toString(16)}` as `0x${string}`;
				if (chainId !== expectedChainId) {
					store.set({state: 'SwithingChain'});
					try {
						await ethereum.request({
							method: 'wallet_switchEthereumChain',
							params: [{chainId: expectedChainIdAsHex}],
						});
					} catch (err) {
						const chainConfig = getConfigFromChainId(expectedChainId);
						try {
							await ethereum.request({
								method: 'wallet_addEthereumChain',
								params: [
									{
										chainId: expectedChainIdAsHex,
										rpcUrls: chainConfig.rpcUrls.default.http as any, // TODO readonly for request (eip-1993)
										blockExplorerUrls: [chainConfig.blockExplorers.default.url],
										chainName: chainConfig.name,
										nativeCurrency: chainConfig.nativeCurrency,
									},
								],
							});
						} catch (err) {
							setError('Failed to change to chain ');
						}
					}
				}
				const newCainIdAsHex = await ethereum.request({method: 'eth_chainId'});
				const newChainId = parseInt(newCainIdAsHex.slice(2), 16).toString();

				console.log({chainId: newChainId});

				if (newChainId !== expectedChainId) {
					setError('Failed to change to chain ');
				}
			} else {
				console.log({chainId});
			}

			let accounts = [];
			if (accountsToUse) {
				if (typeof accountsToUse === 'string') {
					accounts = [accountsToUse];
				} else {
					accounts = await ethereum.request({method: 'eth_accounts'});
					if (accounts.length === 0) {
						accounts = await ethereum.request({method: 'eth_requestAccounts'});
					}
					if (accounts.length === 0) {
						setError('Failed to get accounts');
					}
				}

				console.log({account: accounts[0]});
			}

			store.set({state: 'Ready'});
			return {ethereum, accounts, chainId};
		}
		setError('no web3 wallet found');
	} catch (err) {
		setError(err);
	}
}

export const web3 = {
	subscribe: store.subscribe,
	start,
	reset() {
		store.set({state: 'Idle', error: undefined});
	},
};
