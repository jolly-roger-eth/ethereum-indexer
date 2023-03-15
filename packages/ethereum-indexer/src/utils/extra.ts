import {Abi} from 'abitype';
import {EIP1193Account, EIP1193DATA, EIP1193Provider, EIP1193QUANTITY} from 'eip-1193';
import {decodeFunctionResult, encodeFunctionData} from 'viem';
import {JSONType, LogEventFetcher} from '../decoding/LogEventFetcher';
import {LogEvent} from '../types';

const multicallInterface = [
	{
		inputs: [
			{
				internalType: 'contract IERC165[]',
				name: 'contracts',
				type: 'address[]',
			},
			{
				internalType: 'bytes4',
				name: 'interfaceId',
				type: 'bytes4',
			},
		],
		name: 'supportsInterface',
		outputs: [
			{
				internalType: 'bool[]',
				name: 'result',
				type: 'bool[]',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'contract IERC165[]',
				name: 'contracts',
				type: 'address[]',
			},
			{
				internalType: 'bytes4[]',
				name: 'interfaceIds',
				type: 'bytes4[]',
			},
		],
		name: 'supportsMultipleInterfaces',
		outputs: [
			{
				internalType: 'bool[]',
				name: 'result',
				type: 'bool[]',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
] as const;

export function getmMulti165CallData(contractAddresses: EIP1193Account[]): {
	to: EIP1193Account;
	data: EIP1193DATA;
} {
	const data = encodeFunctionData({
		abi: multicallInterface,
		functionName: 'supportsInterface',
		args: [contractAddresses, '0x80ac58cd'],
	});
	return {to: '0x9f83e74173A34d59D0DFa951AE22336b835AB196', data};
}

export async function multi165(
	provider: EIP1193Provider,
	contractAddresses: EIP1193Account[]
): Promise<readonly boolean[]> {
	const callData = getmMulti165CallData(contractAddresses);
	// TODO specify blockHash for event post the deployment of Multi165 ?
	const response = await provider.request({
		method: 'eth_call',
		params: [{...callData, gas: ('0x' + (28000000).toString(16)) as EIP1193QUANTITY}],
	});

	const result = decodeFunctionResult({
		abi: multicallInterface,
		functionName: 'supportsInterface',
		data: response,
	});
	return result;
}

export async function splitCallAndJoin(provider: EIP1193Provider, contractAddresses: EIP1193Account[]) {
	let result: boolean[] = [];
	const len = contractAddresses.length;
	let start = 0;
	while (start < len) {
		const end = Math.min(start + 800, len);
		const addresses = contractAddresses.slice(start, end);
		const tmp = await multi165(provider, addresses);
		result = result.concat(tmp);
		start = end;
	}
	return result;
}

export function createER721Filter<ABI extends Abi>(
	provider: EIP1193Provider,
	options?: {skipUnParsedEvents?: boolean}
): (eventsFetched: LogEvent<ABI>[]) => Promise<LogEvent<ABI>[]> {
	const erc721Contracts: {[address: EIP1193Account]: boolean} = {};
	return async (eventsFetched: LogEvent<ABI>[]): Promise<LogEvent<ABI>[]> => {
		const addressesMap: {[address: EIP1193Account]: true} = {};
		const addressesToCheck: EIP1193Account[] = [];

		if (options?.skipUnParsedEvents) {
			eventsFetched = eventsFetched.filter((v) => !!(v as any).args);
		}

		for (const event of eventsFetched) {
			if (!erc721Contracts[event.address.toLowerCase()] && !addressesMap[event.address.toLowerCase()]) {
				addressesToCheck.push(event.address);
				addressesMap[event.address.toLowerCase()] = true;
			}
		}
		if (addressesToCheck.length > 0) {
			const responses = await splitCallAndJoin(provider, addressesToCheck);
			for (let i = 0; i < addressesToCheck.length; i++) {
				erc721Contracts[addressesToCheck[i]] = responses[i];
			}
		}

		const events = [];
		for (const event of eventsFetched) {
			const inCache = erc721Contracts[event.address.toLowerCase()];
			if (inCache === true) {
				events.push(event);
				continue;
			} else if (inCache === false) {
				continue;
			}
		}
		return events;
	};
}

const tokenURIInterface = [
	{
		inputs: [
			{
				internalType: 'uint256',
				name: 'id',
				type: 'uint256',
			},
		],
		name: 'tokenURI',
		outputs: [
			{
				internalType: 'string',
				name: '',
				type: 'string',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
] as const;

export async function tokenURI(
	provider: EIP1193Provider,
	contract: EIP1193Account,
	tokenID: bigint,
	blockHash: EIP1193DATA
): Promise<string> {
	const data = encodeFunctionData({abi: tokenURIInterface, functionName: 'tokenURI', args: [tokenID]});
	const response = await provider.request({method: 'eth_call', params: [{to: contract, data}, {blockHash}]});
	const result = decodeFunctionResult({abi: tokenURIInterface, functionName: 'tokenURI', data: response});
	return result;
}

export function createER721TokenURIFetcher<ABI extends Abi>(
	provider: EIP1193Provider
): (event: LogEvent<ABI>) => Promise<JSONType | undefined> {
	return async (event: LogEvent<ABI>): Promise<JSONType | undefined> => {
		if (!('args' in event)) {
			return undefined;
		}
		if (
			!event.args['tokenId'] ||
			!event.args['from'] ||
			event.args['from'] !== '0x0000000000000000000000000000000000000000'
		) {
			return undefined;
		}

		try {
			const uri = await tokenURI(provider, event.address as EIP1193Account, event.args['tokenId'], event.blockHash);
			if (uri) {
				return {
					tokenURIAtMint: uri,
				};
			}
		} catch (e) {}
		return undefined;
	};
}
