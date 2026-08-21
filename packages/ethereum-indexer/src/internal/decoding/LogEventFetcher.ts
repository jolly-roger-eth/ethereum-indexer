import {EIP1193Account, EIP1193DATA, EIP1193ProviderWithoutEvents} from 'eip-1193';
import {ExtraFilters} from '../engine/ethereum.js';
import {LogFetcher, LogFetcherConfig} from '../engine/LogFetcher.js';
import type {Abi, AbiEvent, ExtractAbiEventNames} from 'abitype';
import type {DecodeEventLogReturnType} from 'viem';
import {decodeEventLog, encodeEventTopics} from 'viem';
import {deepEqual} from '../utils/compare.js';
import type {
	IncludedEIP1193Log,
	LogEvent,
	LogEventWithParsingFailure,
	LogParseConfig,
	ParsedLogEvent,
} from '../../types.js';
import {normalizeAddress} from '../utils/address.js';
import {UnlessCancelledFunction} from '../utils/promises.js';

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
	/**
	 * Seconds since the epoch, when the node put it on the log itself.
	 *
	 * Standardised by `ethereum/execution-apis#639` (merged 2025-08-25) and served
	 * by geth >= 1.16.0, reth, besu, erigon and anvil. Optional because it is NOT
	 * universal: Hardhat's EDR does not emit it as of hardhat 3.14.0 / edr 0.3.8,
	 * so a caller that needs a timestamp for every log still needs the
	 * `alwaysFetchTimestamps` fallback for those nodes.
	 */
	blockTimestamp?: number;
}

const HEX_QUANTITY = /^0[xX][0-9a-fA-F]+$/;
const DECIMAL_QUANTITY = /^[0-9]+$/;

/**
 * Read a log's `blockTimestamp` into seconds, or `undefined` if it is absent or
 * unreadable.
 *
 * The parameter is `unknown` rather than `EIP1193QUANTITY` on purpose, and the
 * gap between the two is the point. The spec says QUANTITY, so 0x-prefixed hex,
 * and `eip-1193` types it that way; but at least one client has served it in
 * decimal, and the prefix is the ONLY signal that separates the two:
 * `'1705366720'` is valid hex as well as valid decimal and the readings are
 * millennia apart. The type says what the spec says, this says what the wire
 * does.
 *
 * Anything that is neither is dropped rather than coerced, because a wrong
 * timestamp is worse than a missing one: the caller can fall back on a missing
 * one and cannot detect a wrong one.
 */
export function parseLogBlockTimestamp(value: unknown): number | undefined {
	if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
	if (typeof value !== 'string') return undefined;
	const text = value.trim();
	const seconds = HEX_QUANTITY.test(text)
		? parseInt(text, 16)
		: DECIMAL_QUANTITY.test(text)
			? Number(text)
			: Number.NaN;
	return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : undefined;
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
		private readonly parseConfig?: LogParseConfig,
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
			} as any); // TODO types ?
			// encodeEventTopics returns (Hex | Hex[] | null)[]; when called with only an
			// eventName (no args), the signature topic is always a single Hex string.
			if (topics.length > 0 && typeof topics[0] === 'string') {
				_nameToTopic.set(item.name, topics[0]);
			}
			for (const v of topics) {
				if (typeof v !== 'string') {
					continue;
				}
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
		unlessCancelled: UnlessCancelledFunction,
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
			const blockTimestamp = parseLogBlockTimestamp(log.blockTimestamp);
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
				// kept when the node provides it, so no second round-trip is needed
				...(blockTimestamp === undefined ? {} : {blockTimestamp}),
			};
			const useAllABIEvents = this.abiPerAddress.size === 0 || this.parseConfig?.parseAllEventsIrrespectiveOfAddresses;
			const correspondingABI: AbiEvent[] | undefined = useAllABIEvents
				? this.allABIEvents
				: this.abiPerAddress.get(eventAddress);
			if (correspondingABI) {
				let parsed: DecodeEventLogReturnType<AbiEvent[]> | null = null;
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
					(event as ParsedLogEvent<ABI>).args = parsed.args as any;
					(event as ParsedLogEvent<ABI>).eventName = parsed.eventName as ParsedLogEvent<ABI>['eventName'];
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
