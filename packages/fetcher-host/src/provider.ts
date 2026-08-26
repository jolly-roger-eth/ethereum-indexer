import type {EIP1193ProviderWithoutEvents} from 'eip-1193';
import {JSONRPCHTTPProvider} from 'eip-1193-jsonrpc-provider';

/**
 * A JSON-RPC provider over HTTP, built from a URL.
 *
 * Built here rather than per adapter, and it can be: this client is `fetch` and
 * timers, so it works unchanged in a Node process and in a serverless runtime.
 * That is not incidental to the design. A provider that needed a Node socket
 * would have put chain access on the list of things hosts do differently, and
 * there is supposed to be nothing on that list except when a cycle runs.
 *
 * A host that has its own provider (an injected one, a fake in a test, a
 * transport with different auth) passes it to `createFetcherHost` instead and
 * never reaches this.
 */
export function createJSONRPCProvider(
	url: string,
	options: {requestsPerSecond?: number} = {},
): EIP1193ProviderWithoutEvents {
	const provider = new JSONRPCHTTPProvider(
		url,
		options.requestsPerSecond !== undefined ? {requestsPerSecond: options.requestsPerSecond} : undefined,
	);
	// the package declares its own structurally-identical copy of the EIP-1193
	// surface, which is what the CLI does with it too
	return provider as unknown as EIP1193ProviderWithoutEvents;
}
