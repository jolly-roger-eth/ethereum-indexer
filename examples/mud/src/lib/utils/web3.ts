import type {EIP1193Provider} from 'eip-1193';

export async function connect(
	ethereum: EIP1193Provider,
	config: {
		chain?: {
			chainId: string;
			chainName: string;
			rpcUrls: string[];
			blockExplorerUrls: string[];
			nativeCurrency: {name: string; symbol: string; decimals: number};
		};
		accountsToUse?: `0x${string}`;
	}
) {
	const chainIdAsHex = await ethereum.request({method: 'eth_chainId'});
	const chainId = parseInt(chainIdAsHex.slice(2), 16).toString();
	const chain = config.chain;
	if (chain) {
		const expectedChainIdAsHex = `0x${parseInt(chain.chainId).toString(16)}` as `0x${string}`;
		if (chainId !== chain.chainId) {
			try {
				await ethereum.request({
					method: 'wallet_switchEthereumChain',
					params: [{chainId: expectedChainIdAsHex}],
				});
			} catch (err) {
				await ethereum.request({
					method: 'wallet_addEthereumChain',
					params: [
						{
							chainId: expectedChainIdAsHex,
							rpcUrls: chain.rpcUrls,
							blockExplorerUrls: chain.blockExplorerUrls,
							chainName: chain.chainName,
							nativeCurrency: chain.nativeCurrency,
						},
					],
				});
			}
		}
		const newCainIdAsHex = await ethereum.request({method: 'eth_chainId'});
		const newChainId = parseInt(newCainIdAsHex.slice(2), 16).toString();

		if (newChainId !== chain.chainId) {
			throw new Error('Failed to change to chain ');
		}
	}

	let accounts: `0x${string}`[] = [];
	if (config.accountsToUse) {
		if (typeof config.accountsToUse === 'string') {
			accounts = [config.accountsToUse];
		} else {
			accounts = await ethereum.request({method: 'eth_accounts'});
			if (accounts.length === 0) {
				accounts = await ethereum.request({method: 'eth_requestAccounts'});
			}
			if (accounts.length === 0) {
				throw new Error('Failed to get accounts');
			}
		}
	}
	return {ethereum, accounts, chainId};
}
