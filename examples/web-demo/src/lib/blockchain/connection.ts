import type {EIP1193Provider} from 'eip-1193';
import {writable} from 'svelte/store';
import type {Chain} from 'viem';
import * as chains from 'viem/chains';

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

async function start(expectedChainId: string, requireAccounts: boolean) {
	const expectedChainIdAsHex = `0x${parseInt(expectedChainId).toString(16)}` as `0x${string}`;
	store.set({state: 'Loading'});
	try {
		const ethereum: EIP1193Provider = (window as any).ethereum;

		if (ethereum) {
			const chainIdAsHex = await ethereum.request({method: 'eth_chainId'});
			const chainId = parseInt(chainIdAsHex.slice(2), 16).toString();
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

			let accounts = [];
			if (requireAccounts) {
				accounts = await ethereum.request({method: 'eth_accounts'});
				if (accounts.length === 0) {
					accounts = await ethereum.request({method: 'eth_requestAccounts'});
				}
				if (accounts.length === 0) {
					setError('Failed to get accounts');
				}
			}

			if (newChainId !== expectedChainId) {
				setError('Failed to change to chain ');
			} else {
				store.set({state: 'Ready'});
				return {ethereum, accounts};
			}
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
