import type {EIP1193Provider} from 'eip-1193';
import {writable} from 'svelte/store';

export type Web3Connection = {state: 'Idle' | 'Loading' | 'SwithingChain' | 'Ready'; error?: string};
const store = writable<Web3Connection>({
	state: 'Idle',
});

function setError(message: string) {
	store.set({state: 'Idle', error: message});
	throw new Error(message);
}

async function start() {
	store.set({state: 'Loading'});
	try {
		const ethereum: EIP1193Provider = (window as any).ethereum;

		if (ethereum) {
			const chainIdAsHex = await ethereum.request({method: 'eth_chainId'});
			const chainId = parseInt(chainIdAsHex.slice(2), 16).toString();
			if (chainId !== '100') {
				store.set({state: 'SwithingChain'});
				try {
					await ethereum.request({method: 'wallet_switchEthereumChain', params: [{chainId: `0x64`}]});
				} catch (err) {
					try {
						await ethereum.request({
							method: 'wallet_addEthereumChain',
							params: [
								{
									chainId: `0x64`,
									rpcUrls: ['https://rpc.gnosischain.com/'],
									blockExplorerUrls: ['https://blockscout.com/xdai/mainnet/'],
									chainName: 'Gnosis',
									nativeCurrency: {
										decimals: 18,
										name: 'Gnosis',
										symbol: 'xDAI',
									},
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
			if (newChainId !== '100') {
				setError('Failed to change to chain ');
			} else {
				store.set({state: 'Ready'});
				return ethereum;
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
};
