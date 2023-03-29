import {getAddress} from 'viem';
export function normalizeAddress(addr: `0x${string}`): `0x${string}` {
	// return addr.toLowerCase() as `0x${string}`;
	return getAddress(addr);
}
