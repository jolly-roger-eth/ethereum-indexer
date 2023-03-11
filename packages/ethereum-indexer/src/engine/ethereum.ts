import {
	EIP1193Account,
	EIP1193Block,
	EIP1193DATA,
	EIP1193GenericRequest,
	EIP1193Log,
	EIP1193ProviderWithoutEvents,
	EIP1193TransactionReceipt,
} from 'eip-1193';

/**
 * Data from the tx that emitted the log.
 * It is not automatically added to the log as this require fetching extra information.
 */
export type LogTransactionData = {
	/**
	 * tx.origin, signer of the tx.
	 */
	from: string;
	/**
	 * Gas amount used by the tx.
	 */
	gasUsed: number;
	/**
	 * The sum of the base fee and tip paid per unit of gas by the tx.
	 * (In hex format)
	 */
	effectiveGasPrice: `0x${string}`;
};

export type ExtendedEIP1193Provider = EIP1193ProviderWithoutEvents &
	Partial<{
		request(args: {method: 'eth_batch'; params: EIP1193GenericRequest[]}): Promise<unknown[]>;
	}>;

export async function getBlockNumber(provider: EIP1193ProviderWithoutEvents): Promise<number> {
	const blockAsHexString = await provider.request({method: 'eth_blockNumber'});
	return parseInt(blockAsHexString.slice(2), 16);
}

export async function getChainId(provider: EIP1193ProviderWithoutEvents): Promise<string> {
	const blockAsHexString = await provider.request({method: 'eth_chainId'});
	return parseInt(blockAsHexString.slice(2), 16).toString();
}

// NOTE: only interested in the timestamp for now
export async function getBlockData(
	provider: EIP1193ProviderWithoutEvents,
	hash: EIP1193DATA
): Promise<{timestamp: number}> {
	const blockWithHexStringFields = await provider.request({method: 'eth_getBlockByHash', params: [hash, false]});
	return {
		timestamp: parseInt(blockWithHexStringFields.timestamp.slice(2), 16),
	};
}

// NOTE: only interested in the timestamp for now
export async function getBlockDataFromMultipleHashes(
	provider: EIP1193ProviderWithoutEvents,
	hashes: string[]
): Promise<{timestamp: number}[]> {
	const requests: EIP1193GenericRequest[] = [];
	for (const hash of hashes) {
		requests.push({
			method: 'eth_getBlockByHash',
			params: [hash, false],
		});
	}
	const blocksWithHexStringFields = await (provider as ExtendedEIP1193Provider).request({
		method: 'eth_batch',
		params: requests,
	});

	return (blocksWithHexStringFields as EIP1193Block[]).map((block) => ({
		timestamp: parseInt(block.timestamp.slice(2), 16),
	}));
}

export async function getTransactionData(
	provider: EIP1193ProviderWithoutEvents,
	hash: EIP1193DATA
): Promise<LogTransactionData> {
	const transactionReceiptWithHexStringFields = await provider.request({
		method: 'eth_getTransactionReceipt',
		params: [hash],
	});

	return {
		from: transactionReceiptWithHexStringFields.from,
		gasUsed: parseInt(transactionReceiptWithHexStringFields.gasUsed.slice(2), 16),
		effectiveGasPrice: transactionReceiptWithHexStringFields.effectiveGasPrice,
	};
}

export async function getTransactionDataFromMultipleHashes(
	provider: EIP1193ProviderWithoutEvents,
	hashes: string[]
): Promise<LogTransactionData[]> {
	const requests: EIP1193GenericRequest[] = [];
	for (const hash of hashes) {
		requests.push({
			method: 'eth_getTransactionReceipt',
			params: [hash],
		});
	}
	const transactionReceiptsWithHexStringFields = <EIP1193TransactionReceipt[]>(
		await (provider as ExtendedEIP1193Provider).request({method: 'eth_batch', params: requests})
	);

	return transactionReceiptsWithHexStringFields.map((transaction) => {
		return {
			from: transaction.from,
			gasUsed: parseInt(transaction.gasUsed.slice(2), 16),
			effectiveGasPrice: transaction.effectiveGasPrice,
			// value: transaction.value
		};
	});
}

type LogRequest = {topics: (`0x${string}` | `0x${string}`[])[]; contractAddresses: `0x${string}`[] | null};
export function generateLogRequestForTopicsAndFiltersCombinations(
	contractAddresses: `0x${string}`[] | null,
	eventNameTopics: EIP1193DATA[],
	filters?: {
		[topicSignature: `0x${string}`]: {contractAddresses?: `0x${string}`[]; list: (`0x${string}` | `0x${string}`[])[][]};
	}
): LogRequest[] {
	if (!filters) {
		return [{topics: [eventNameTopics], contractAddresses}];
	} else {
		const sharedRequest = {topics: [], contractAddresses};
		const moreRequests: LogRequest[] = [];
		for (const eventNameTopic of eventNameTopics) {
			const filtersPerEventTopic = filters[eventNameTopic];
			if (filtersPerEventTopic) {
				for (const filter of filtersPerEventTopic.list) {
					moreRequests.push({
						topics: [eventNameTopic, ...filter],
						contractAddresses: filtersPerEventTopic.contractAddresses || contractAddresses,
					});
				}
			} else {
				sharedRequest.topics.push(eventNameTopic);
			}
		}
		// TODO optimise further and combine eventNameTopic's filters who share the same filter
		if (sharedRequest.topics.length > 0) {
			return [sharedRequest, ...moreRequests];
		} else {
			return moreRequests;
		}
	}
}

export type ExtraFilters = {
	[topicSignature: `0x${string}`]: {contractAddresses?: `0x${string}`[]; list: (`0x${string}` | `0x${string}`[])[][]};
};
export async function getLogsWithVariousFilters(
	provider: EIP1193ProviderWithoutEvents,
	contractAddresses: EIP1193Account[] | null,
	eventNameTopics: EIP1193DATA[] | null,
	filters: ExtraFilters | null,
	options: {fromBlock: number; toBlock: number}
): Promise<EIP1193Log[]> {
	if (!eventNameTopics) {
		return getLogs(provider, contractAddresses, [eventNameTopics], options);
	}
	const requestList = generateLogRequestForTopicsAndFiltersCombinations(contractAddresses, eventNameTopics, filters);

	const logs: EIP1193Log[] = [];
	for (const request of requestList) {
		const tmpLogs = await getLogs(provider, request.contractAddresses, request.topics, options);
		logs.push(...tmpLogs);
	}

	return logs.sort((a, b) => {
		const aT = parseInt(a.transactionIndex.slice(2), 16);
		const bT = parseInt(b.transactionIndex.slice(2), 16);
		if (aT > bT) {
			return 1;
		} else if (aT < bT) {
			return -1;
		} else {
			const aL = parseInt(a.logIndex.slice(2), 16);
			const bL = parseInt(b.logIndex.slice(2), 16);
			if (aL > bL) {
				return 1;
			} else if (aL < bL) {
				return -1;
			} else {
				return 0;
			}
		}
	});
}

export async function getLogs(
	provider: EIP1193ProviderWithoutEvents,
	contractAddresses: EIP1193Account[] | null,
	topics: (EIP1193DATA | EIP1193DATA[])[] | null,
	options: {fromBlock: number; toBlock: number}
): Promise<EIP1193Log[]> {
	const logs: EIP1193Log[] = await provider.request({
		method: 'eth_getLogs',
		params: [
			{
				address: contractAddresses,
				fromBlock: ('0x' + options.fromBlock.toString(16)) as EIP1193DATA,
				toBlock: ('0x' + options.toBlock.toString(16)) as EIP1193DATA,
				topics: topics ? topics : undefined,
			},
		],
	});
	return logs;
}
