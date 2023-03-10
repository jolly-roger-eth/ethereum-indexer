import {EIP1193Account, EIP1193DATA, EIP1193Log, EIP1193ProviderWithoutEvents} from 'eip-1193';
import {LogTransactionData} from '../engine/ethereum';
import {LogFetcher, LogFetcherConfig} from '../engine/LogFetcher';
import type {Abi, AbiEvent, ExtractAbiEventNames} from 'abitype';
import {decodeEventLog, DecodeEventLogReturnType, encodeEventTopics} from 'viem';

export type JSONObject = {
	[key: string]: JSONType;
};

export type JSONType = string | number | boolean | JSONType[] | JSONObject;

interface Result extends ReadonlyArray<any> {
	readonly [key: string]: any;
}

interface NumberifiedLog {
	blockNumber: number;
	blockHash: string;
	transactionIndex: number;

	removed: boolean;

	address: string;
	data: string;

	topics: Array<string>;

	transactionHash: string;
	logIndex: number;
}

// type Omit<T, K extends keyof T> = Pick<T, Exclude<keyof T, K>>;
// type PartialBy<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;
type PartialBy<T, K extends keyof T> = T; // TODO ?
export type LogParsedData<ABI extends Abi> = DecodeEventLogReturnType<ABI, string, `0x${string}`[], `0x${string}`>;
export type LogEvent<ABI extends Abi, Extra extends JSONObject = JSONObject> = NumberifiedLog &
	PartialBy<LogParsedData<ABI>, 'args' | 'eventName'> & {
		decodeError?: Error;
		extra?: Extra;
		blockTimestamp?: number;
		transaction?: LogTransactionData;
	};

export type ParsedLogsResult<ABI extends Abi> = {events: LogEvent<ABI>[]; toBlockUsed: number};
export type ParsedLogsPromise<ABI extends Abi> = Promise<ParsedLogsResult<ABI>> & {stopRetrying(): void};

export class LogEventFetcher<ABI extends Abi> extends LogFetcher {
	constructor(
		readonly provider: EIP1193ProviderWithoutEvents,
		readonly contractsData: readonly {readonly address: string; readonly abi: ABI}[] | {readonly abi: ABI},
		readonly conf: LogFetcherConfig = {}
	) {
		let contractAddresses: EIP1193Account[] | null = null;
		let eventABIS: readonly AbiEvent[][];
		if (Array.isArray(contractsData)) {
			contractAddresses = contractsData.map((v) => v.address);
			eventABIS = (contractsData as readonly {readonly address: string; readonly abi: ABI}[]).map((v) =>
				v.abi.filter((item) => item.type === 'event')
			) as unknown as AbiEvent[][];
		} else {
			// contracts = new InterfaceWithLowerCaseAddresses((contractsData as {readonly abi: T}).abi);
			const allContractsData = contractsData as {readonly abi: ABI};
			eventABIS = [allContractsData.abi.filter((item) => item.type === 'event')] as unknown as AbiEvent[][];
		}

		let eventNameTopics: EIP1193DATA[] | null = null;
		for (const abi of eventABIS) {
			for (const item of abi) {
				const topics = encodeEventTopics({
					abi,
					eventName: item.name as ExtractAbiEventNames<ABI>,
				});
				eventNameTopics = eventNameTopics || [];
				eventNameTopics.push(...topics);
			}
		}

		super(provider, contractAddresses, eventNameTopics, conf);
	}

	getLogEvents(options: {fromBlock: number; toBlock: number; retry?: number}): ParsedLogsPromise<ABI> {
		const logsPromise = this.getLogs(options);
		const promise = logsPromise.then(({logs, toBlockUsed}) => {
			const events = this.parse(logs);
			return {events, toBlockUsed};
		});

		(promise as ParsedLogsPromise<ABI>).stopRetrying = logsPromise.stopRetrying;
		return promise as ParsedLogsPromise<ABI>;
	}

	parse(logs: EIP1193Log[]): LogEvent<ABI>[] {
		const events: LogEvent<ABI>[] = [];
		for (let i = 0; i < logs.length; i++) {
			const log = logs[i];
			const eventAddress = log.address.toLowerCase();
			const correspondingABI: ABI = !Array.isArray(this.contractsData)
				? this.contractsData
				: this.contractsData.find((v) => v.address.toLowerCase() === eventAddress.toLowerCase())?.abi;
			if (correspondingABI) {
				const event: NumberifiedLog = {
					blockNumber: parseInt(log.blockNumber.slice(2), 16),
					blockHash: log.blockHash,
					transactionIndex: parseInt(log.transactionIndex.slice(2), 16),
					removed: log.removed ? true : false,
					address: log.address,
					data: log.data,
					topics: log.topics,
					transactionHash: log.transactionHash,
					logIndex: parseInt(log.logIndex.slice(2), 16),
				};
				let parsed: DecodeEventLogReturnType<ABI, string, `0x${string}`[], `0x${string}`> | null = null;
				try {
					parsed = decodeEventLog({
						abi: correspondingABI,
						data: log.data,
						topics: log.topics as [signature: `0x${string}`, ...args: `0x${string}`[]],
					});
				} catch (err) {
					(event as LogEvent<ABI>).decodeError = err;
				}

				if (parsed) {
					(event as LogEvent<ABI>).args = parsed.args;
					(event as LogEvent<ABI>).eventName = parsed.eventName;
				}

				events.push(event as LogEvent<ABI>);
			}
		}
		return events;
	}
}
