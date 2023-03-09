import {EIP1193Account, EIP1193DATA, EIP1193ProviderWithoutEvents, EIP1193QUANTITY} from 'eip-1193';
import {InterfaceWithLowerCaseAddresses} from './address';
import {JSONType, LogEvent} from './LogEventFetcher';

const multicallInterface = new InterfaceWithLowerCaseAddresses([
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
]);

export function getmMulti165CallData(contractAddresses: string[]): {
	to: EIP1193Account;
	data: EIP1193DATA;
} {
	const data = multicallInterface.encodeFunctionData('supportsInterface', [
		contractAddresses,
		'0x80ac58cd',
	]) as EIP1193DATA;
	return {to: '0x9f83e74173A34d59D0DFa951AE22336b835AB196', data};
}

export async function multi165(
	provider: EIP1193ProviderWithoutEvents,
	contractAddresses: string[]
): Promise<boolean[]> {
	const callData = getmMulti165CallData(contractAddresses);
	// TODO specify blockHash for event post the deployment of Multi165 ?
	const response = await provider.request({
		method: 'eth_call',
		params: [{...callData, gas: ('0x' + (28000000).toString(16)) as EIP1193QUANTITY}],
	});
	const result: boolean[] = multicallInterface.decodeFunctionResult('supportsInterface', response)[0];
	return result;
}

export async function splitCallAndJoin(provider: EIP1193ProviderWithoutEvents, contractAddresses: string[]) {
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

export function createER721Filter(
	provider: EIP1193ProviderWithoutEvents,
	options?: {skipUnParsedEvents?: boolean}
): (eventsFetched: LogEvent[]) => Promise<LogEvent[]> {
	const erc721Contracts: {[address: string]: boolean} = {};
	return async (eventsFetched: LogEvent[]): Promise<LogEvent[]> => {
		const addressesMap: {[address: string]: true} = {};
		const addressesToCheck: string[] = [];

		if (options?.skipUnParsedEvents) {
			eventsFetched = eventsFetched.filter((v) => !!v.args);
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

const tokenURIInterface = new InterfaceWithLowerCaseAddresses([
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
]);

export async function tokenURI(
	provider: EIP1193ProviderWithoutEvents,
	contract: EIP1193Account,
	tokenID: string,
	blockHash: string
): Promise<string> {
	const data = tokenURIInterface.encodeFunctionData('tokenURI', [tokenID]) as EIP1193DATA;
	const response = await provider.request({
		method: 'eth_call',
		params: [{to: contract, data}, blockHash as EIP1193DATA],
	});
	const result: string = tokenURIInterface.decodeFunctionResult('tokenURI', response)[0];
	return result;
}

export function createER721TokenURIFetcher(
	provider: EIP1193ProviderWithoutEvents
): (event: LogEvent) => Promise<JSONType | undefined> {
	return async (event: LogEvent): Promise<JSONType | undefined> => {
		if (
			!event.args ||
			!event.args['tokenId'] ||
			!event.args['from'] ||
			event.args['from'] !== '0x0000000000000000000000000000000000000000'
		) {
			return undefined;
		}

		try {
			const uri = await tokenURI(
				provider,
				event.address as EIP1193Account,
				event.args['tokenId'] as string,
				event.blockHash
			);
			if (uri) {
				return {
					tokenURIAtMint: uri,
				};
			}
		} catch (e) {}
		return undefined;
	};
}
