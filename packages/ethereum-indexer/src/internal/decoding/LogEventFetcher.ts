import {EIP1193Account, EIP1193DATA, EIP1193ProviderWithoutEvents} from 'eip-1193';
import {ExtraFilters} from '../engine/ethereum';
import {LogFetcher, LogFetcherConfig} from '../engine/LogFetcher';
import type {Abi, AbiEvent, ExtractAbiEventNames} from 'abitype';
import type {DecodeEventLogReturnType} from 'viem';
import {decodeEventLog, encodeEventTopics} from 'viem';
import {deepEqual} from '../utils/compare';
import {IncludedEIP1193Log, LogEvent, LogEventWithParsingFailure, LogParseConfig, ParsedLogEvent} from '../../types';
import {normalizeAddress} from '../utils/address';
import {UnlessCancelledFunction} from '../utils/promises';

function deleteDuplicateEvents(events: AbiEvent[], failOnIdenticalNameButDifferentInputs: boolean) {
	const map = new Map();
	for (let i = 0; i < events.length; i++) {
		const event = events[i];
		const namedEvent = map.get(event.name);
		if (!namedEvent) {
			map.set(event.name, event);
		} else {
			if (failOnIdenticalNameButDifferentInputs) {
				if (!deepEqual(event.inputs, namedEvent.inputs)) {
					// {a: event, b: namedEvent}
					throw new Error(`two events with same name but different inputs`);
				}
			}
			// delete
			events.splice(i, 1);
			i--;
		}
	}
}

export interface NumberifiedLog {
	blockNumber: number;
	blockHash: `0x${string}`;
	transactionIndex: number;
	removed: boolean;
	address: `0x${string}`;
	data: `0x${string}`;
	topics: Array<`0x${string}`>;
	transactionHash: `0x${string}`;
	logIndex: number;
}

export type ParsedLogsResult<ABI extends Abi> = {events: LogEvent<ABI>[]; toBlockUsed: number};
export type ParsedLogsPromise<ABI extends Abi> = Promise<ParsedLogsResult<ABI>> & {stopRetrying(): void};

type OneABI<ABI extends Abi> = {readonly abi: ABI};
type ContractList<ABI extends Abi> = readonly {readonly address: `0x${string}`; readonly abi: ABI}[];

export class LogEventFetcher<ABI extends Abi> extends LogFetcher {
	private abiEventPerTopic: Map<`0x${string}`, AbiEvent>;
	private abiPerAddress: Map<`0x${string}`, AbiEvent[]>;
	private allABIEvents: AbiEvent[];

	constructor(
		readonly provider: EIP1193ProviderWithoutEvents,
		readonly contractsData: ContractList<ABI> | OneABI<ABI>,
		readonly fetcherConfig: LogFetcherConfig = {},
		private readonly parseConfig?: LogParseConfig
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
				const contractAddress = normalizeAddress(contract.address);
				const contractEventsABI: AbiEvent[] = contract.abi.filter((item) => item.type === 'event') as AbiEvent[];
				const abiAtThatAddress = _abiPerAddress.get(contractAddress);
				if (!abiAtThatAddress) {
					_abiPerAddress.set(contractAddress, contractEventsABI);
					contractAddresses.push(contractAddress);
				} else {
					abiAtThatAddress.push(...contractEventsABI);
					deleteDuplicateEvents(abiAtThatAddress, true);
				}
				_allABIEvents.push(...contractEventsABI);

				for (const event of contractEventsABI) {
					const list = _eventNameToContractAddresses.get(event.name) || [];
					if (list.length === 0) {
						_eventNameToContractAddresses.set(event.name, list);
					}
					if (list.indexOf(contractAddress) === -1) {
						list.push(contractAddress);
					}
				}
			}
		} else {
			const allContractsData = contractsData as {readonly abi: ABI};
			_allABIEvents.push(...(allContractsData.abi.filter((item) => item.type === 'event') as AbiEvent[]));
		}

		deleteDuplicateEvents(_allABIEvents, false);

		const eventNameTopics: EIP1193DATA[] = [];
		for (const item of _allABIEvents) {
			const topics = encodeEventTopics({
				abi: _allABIEvents,
				eventName: item.name as ExtractAbiEventNames<ABI>,
			});
			if (topics.length > 0) {
				_nameToTopic.set(item.name, topics[0]);
			}
			for (const v of topics) {
				if (!_abiEventPerTopic.get(v)) {
					_abiEventPerTopic.set(v, item);
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
				const signatureTopic = _nameToTopic.get(eventName);
				if (signatureTopic) {
					filters[signatureTopic] = {
						list: filterList,
						contractAddresses: _eventNameToContractAddresses.get(eventName),
					};
				}
			}
			fetcherConfig = {...fetcherConfig, filters};
		}

		super(provider, contractAddresses, eventNameTopics, fetcherConfig);
		this.allABIEvents = _allABIEvents;
		this.abiPerAddress = _abiPerAddress;
		this.abiEventPerTopic = _abiEventPerTopic;
	}

	async getLogEvents(
		options: {fromBlock: number; toBlock: number; retry?: number},
		unlessCancelled: UnlessCancelledFunction
	): Promise<ParsedLogsResult<ABI>> {
		const {logs, toBlockUsed} = await this.getLogs(options, unlessCancelled);
		const events = this.parse(logs);
		return {events, toBlockUsed};
	}

	parse(logs: IncludedEIP1193Log[]): LogEvent<ABI>[] {
		const events: LogEvent<ABI>[] = [];
		for (let i = 0; i < logs.length; i++) {
			const log = logs[i];
			const eventAddress = normalizeAddress(log.address);
			const event: NumberifiedLog = {
				blockNumber: parseInt(log.blockNumber.slice(2), 16),
				blockHash: log.blockHash,
				transactionIndex: parseInt(log.transactionIndex.slice(2), 16),
				removed: log.removed ? true : false,
				address: eventAddress,
				data: log.data,
				topics: log.topics,
				transactionHash: log.transactionHash,
				logIndex: parseInt(log.logIndex.slice(2), 16),
			};
			const correspondingABI: AbiEvent[] | undefined =
				this.abiPerAddress.size === 0 || !this.parseConfig?.onlyParseEventsAssignedInRespectiveContracts
					? this.allABIEvents
					: this.abiPerAddress.get(eventAddress);
			if (correspondingABI) {
				let parsed: DecodeEventLogReturnType<ABI, string, `0x${string}`[], `0x${string}`> | null = null;
				try {
					parsed = decodeEventLog({
						abi: correspondingABI,
						data: log.data,
						topics: log.topics as [signature: `0x${string}`, ...args: `0x${string}`[]],
					});
				} catch (err) {
					parsed = null;
					(event as LogEventWithParsingFailure).decodeError = `decoding error: ${err}`;
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

			if (this.parseConfig?.logValues) {
				const eventWithFilteredValues: LogEvent<ABI> = {} as LogEvent<ABI>;
				if ((event as any).args) {
					(eventWithFilteredValues as any).args = (event as any).args;
				}
				for (const key of Object.keys(this.parseConfig.logValues)) {
					if (typeof (event as any)[key] !== 'undefined') {
						(eventWithFilteredValues as any)[key] = (event as any)[key];
					}
				}
				events.push(eventWithFilteredValues);
			} else {
				events.push(event as LogEvent<ABI>);
			}
		}
		return events;
	}
}
