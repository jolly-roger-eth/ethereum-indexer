/**
 * A fake EIP-6963 wallet, injected into the page before any of its own script runs.
 *
 * It is a REAL provider, not a mock that returns canned answers: everything
 * except `eth_chainId` and the account methods is proxied to a JSON-RPC endpoint
 * over `fetch`. That matters, because the property under test is that reads
 * ROUTE THROUGH THE WALLET, and a stub that answered `eth_getLogs` itself would
 * prove only that the page called something.
 *
 * It counts its own calls on `window.__walletCalls`, which is how a test tells
 * "indexed through the wallet" from "indexed through the endpoint" -- the two are
 * otherwise indistinguishable, since both land on the same rows.
 *
 * Returned as a STRING to hand to `page.addInitScript`, because the browser must
 * define `window.ethereum` and the announcement listener before the app's module
 * evaluates; a wallet that announces itself late is a different scenario.
 */
export function walletStub({wallets, chainId = '0x1', accounts = [], rpc}) {
	return `(() => {
		window.__walletCalls = 0;
		const rpc = ${JSON.stringify(rpc)};
		const chainId = ${JSON.stringify(chainId)};
		const accounts = ${JSON.stringify(accounts)};

		function makeProvider() {
			return {
				async request(args) {
					const method = args && args.method;
					window.__walletCalls++;
					if (method === 'eth_chainId') return chainId;
					if (method === 'eth_requestAccounts' || method === 'eth_accounts') return accounts;
					const res = await fetch(rpc, {
						method: 'POST',
						headers: {'content-type': 'application/json'},
						body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params: (args && args.params) || []}),
					});
					const json = await res.json();
					if (json.error) { const e = new Error(json.error.message); e.code = json.error.code; throw e; }
					return json.result;
				},
				on() {}, removeListener() {}, removeAllListeners() {},
			};
		}

		const announced = ${JSON.stringify(wallets)}.map((info) => ({info, provider: makeProvider()}));

		// The legacy slot as well: a wallet that supports EIP-6963 generally also
		// occupies window.ethereum, and the connector only falls back to it when
		// nothing announced itself. Setting both is the realistic shape.
		if (announced.length > 0) window.ethereum = announced[0].provider;

		function announce() {
			for (const w of announced) {
				window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {detail: Object.freeze(w)}));
			}
		}
		window.addEventListener('eip6963:requestProvider', announce);
		announce();
	})();`;
}

/** Two wallets, so the multi-wallet picker is reachable. */
export const METAMASK = {
	uuid: '11111111-1111-1111-1111-111111111111',
	name: 'MetaMask',
	icon: 'data:,',
	rdns: 'io.metamask',
};
export const RABBY = {uuid: '22222222-2222-2222-2222-222222222222', name: 'Rabby', icon: 'data:,', rdns: 'io.rabby'};
