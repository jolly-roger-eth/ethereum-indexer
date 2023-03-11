import {EIP1193Account, EIP1193DATA, EIP1193Log, EIP1193ProviderWithoutEvents} from 'eip-1193';
import {ExtraFilters, LogTransactionData} from '../engine/ethereum';
import {LogFetcher, LogFetcherConfig} from '../engine/LogFetcher';
import type {Abi, AbiEvent, ExtractAbiEventNames} from 'abitype';
import {decodeEventLog, DecodeEventLogReturnType, encodeEventTopics} from 'viem';
import {deepEqual} from '../utils/compae';

function deleteDuplicateEvents(events: AbiEvent[], map?: Map<string, AbiEvent>) {
	if (!map) {
		map = new Map();
	}
	for (let i = 0; i < events.length; i++) {
		const event = events[i];
		const namedEvent = map[event.name];
		if (!namedEvent) {
			map[event.name] = event;
		} else {
			if (!deepEqual(event.inputs, namedEvent.inputs)) {
				// {a: event, b: namedEvent}
				throw new Error(`two events with same name but different inputs`);
			}
			// delete
			events.splice(i, 1);
			i--;
		}
	}
}

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

export type LogParsedData<ABI extends Abi> = DecodeEventLogReturnType<ABI, string, `0x${string}`[], `0x${string}`>;
export type BaseLogEvent<Extra extends JSONObject = undefined> = NumberifiedLog & {
	extra: Extra;
	blockTimestamp?: number;
	transaction?: LogTransactionData;
};
export type ParsedLogEvent<ABI extends Abi, Extra extends JSONObject = undefined> = BaseLogEvent<Extra> &
	LogParsedData<ABI>;
export type LogEventWithParsingFailure<Extra extends JSONObject = undefined> = BaseLogEvent<Extra> & {
	decodeError: string;
};
export type LogEvent<ABI extends Abi, Extra extends JSONObject = undefined> =
	| ParsedLogEvent<ABI, Extra>
	| LogEventWithParsingFailure<Extra>;

export type ParsedLogsResult<ABI extends Abi> = {events: LogEvent<ABI>[]; toBlockUsed: number};
export type ParsedLogsPromise<ABI extends Abi> = Promise<ParsedLogsResult<ABI>> & {stopRetrying(): void};

type OneABI<ABI extends Abi> = {readonly abi: ABI};
type ContractList<ABI extends Abi> = readonly {readonly address: `0x${string}`; readonly abi: ABI}[];

export class LogEventFetcher<ABI extends Abi> extends LogFetcher {
	private abiPerAddress: Map<`0x${string}`, AbiEvent[]>;
	private allABIEvents: AbiEvent[];

	constructor(
		readonly provider: EIP1193ProviderWithoutEvents,
		readonly contractsData: ContractList<ABI> | OneABI<ABI>,
		readonly fetcherConfig: LogFetcherConfig = {},
		private readonly parseConfig?: {
			globalABI?: boolean;
			filters?: {
				// for each event name we can specify a list of filter
				// each filter is an array of (topic or topic[])
				// so this is an array of array of (topic | topic[])
				[eventName: string]: (`0x${string}` | `0x${string}`[])[][];
			};
		}
	) {
		const _abiEventPerTopic: Map<`0x${string}`, AbiEvent> = new Map();
		const _nameToTopic: Map<string, `0x${string}`> = new Map();
		const _abiPerAddress: Map<`0x${string}`, AbiEvent[]> = new Map();
		const _eventNameToContractAddresses: Map<string, `0x${string}`[]> = new Map();
		const _allABIEvents: AbiEvent[] = [];
		let contractAddresses: EIP1193Account[] | null = null;
		if (Array.isArray(contractsData)) {
			contractAddresses = [];
			for (const contract of contractsData as ContractList<ABI>) {
				const contractEventsABI: AbiEvent[] = contract.abi.filter((item) => item.type === 'event') as AbiEvent[];
				const abiAtThatAddress = _abiPerAddress[contract.address];
				if (!abiAtThatAddress) {
					_abiPerAddress[contract.address] = contractEventsABI;
					contractAddresses.push(contract.address);
				} else {
					abiAtThatAddress.push(...contractEventsABI);
					deleteDuplicateEvents(abiAtThatAddress);
				}

				for (const event of contractEventsABI) {
					const list = _eventNameToContractAddresses[event.name] || [];
					if (list.length === 0) {
						_eventNameToContractAddresses[event.name] = list;
					}
					if (list.indexOf(contract.address) === -1) {
						list.push(contract.address);
					}
				}
			}
		} else {
			const allContractsData = contractsData as {readonly abi: ABI};
			_allABIEvents.push(...(allContractsData.abi.filter((item) => item.type === 'event') as AbiEvent[]));
		}

		const _abiEventPerName: Map<string, AbiEvent> = new Map();
		deleteDuplicateEvents(_allABIEvents, _abiEventPerName);

		const eventNameTopics: EIP1193DATA[] = [];
		for (const item of _allABIEvents) {
			const topics = encodeEventTopics({
				abi: _allABIEvents,
				eventName: item.name as ExtractAbiEventNames<ABI>,
			});
			if (topics.length > 0) {
				_nameToTopic[item.name] = topics[0];
			}
			for (const v of topics) {
				if (!_abiEventPerTopic[v]) {
					_abiEventPerTopic[v] = item;
					eventNameTopics.push(v);
				} else {
					throw new Error(`duplicate topics found`);
				}
			}
		}

		if (parseConfig?.filters) {
			const filters: ExtraFilters = {};
			for (const eventName of Object.keys(parseConfig.filters)) {
				const filterList = parseConfig.filters[eventName];
				filters[_nameToTopic[eventName]] = {
					list: filterList,
					contractAddresses: _eventNameToContractAddresses[eventName],
				};
			}
			fetcherConfig = {...fetcherConfig, filters};
		}

		super(provider, contractAddresses, eventNameTopics, fetcherConfig);
		this.allABIEvents = _allABIEvents;
		this.abiPerAddress = _abiPerAddress;
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
			const correspondingABI: AbiEvent[] =
				this.abiPerAddress.size == 0 || this.parseConfig?.globalABI
					? this.allABIEvents
					: this.abiPerAddress[eventAddress];
			if (correspondingABI) {
				let parsed: DecodeEventLogReturnType<ABI, string, `0x${string}`[], `0x${string}`> | null = null;
				try {
					parsed = decodeEventLog({
						abi: correspondingABI,
						data: log.data,
						topics: log.topics as [signature: `0x${string}`, ...args: `0x${string}`[]],
					});
				} catch (err) {
					(event as LogEventWithParsingFailure).decodeError = `decoding error: ${err.toString()}`;
				}

				if (parsed) {
					(event as ParsedLogEvent<ABI>).args = parsed.args;
					(event as ParsedLogEvent<ABI>).eventName = parsed.eventName;
				} else {
					(event as LogEventWithParsingFailure).decodeError = `parsing did not return any results`;
				}
			} else {
				(event as LogEventWithParsingFailure).decodeError = `event triggered at a different address`;
			}
			events.push(event as LogEvent<ABI>);
		}
		return events;
	}
}
