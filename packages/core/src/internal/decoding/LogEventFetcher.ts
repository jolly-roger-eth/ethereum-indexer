import {EIP1193Account, EIP1193DATA, EIP1193ProviderWithoutEvents} from 'eip-1193';
import {ExtraFilters} from '../engine/ethereum.js';
import {RangeLogFetcher, LogFetcherConfig} from '../engine/RangeLogFetcher.js';
import type {Abi, AbiEvent} from 'abitype';
import type {DecodeEventLogReturnType} from 'viem';
import {decodeEventLog, toEventSelector, toEventSignature} from 'viem';
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

/**
 * The `topic0` an event's logs carry, or `undefined` for an ANONYMOUS event,
 * which carries none.
 *
 * Computed per EVENT and never by name, which is the whole point:
 * `encodeEventTopics` selects an ABI item by NAME, so two events sharing a name
 * resolve to whichever one it found first, and the other's topic0 could never
 * enter the fetch filter.
 */
function topic0Of(event: AbiEvent): `0x${string}` | undefined {
	return event.anonymous ? undefined : toEventSelector(event);
}

/** An event as an operator would recognise it in the ABI, for a refusal message. */
function describeEventDeclaration(event: AbiEvent): string {
	const inputs = event.inputs
		.map((input) => `${input.type}${input.indexed ? ' indexed' : ''}${input.name ? ` ${input.name}` : ''}`)
		.join(', ');
	return `${event.anonymous ? 'anonymous ' : ''}event ${event.name}(${inputs})`;
}

/**
 * What decoding a log against this event actually READS.
 *
 * Deliberately NOT `internalType`, which is a Solidity-side annotation that two
 * compilations of the same event routinely disagree about (`address` vs
 * `contract IERC20`). Refusing on it would reject an ABI that is genuinely the
 * same event, and this refusal stops the indexer starting, so it has to be
 * about the wire and nothing else. A missing parameter name reads as `''` for
 * the same reason.
 */
function decodingShapeOf(event: AbiEvent): unknown {
	const shapeOfParameter = (parameter: any): unknown => ({
		name: parameter.name ?? '',
		type: parameter.type,
		indexed: !!parameter.indexed,
		components: parameter.components ? parameter.components.map(shapeOfParameter) : undefined,
	});
	return {anonymous: !!event.anonymous, inputs: event.inputs.map(shapeOfParameter)};
}

/**
 * Collapse the events that ARE the same event, and refuse the ones nothing can
 * tell apart. ONE rule, applied identically wherever an ABI list is built.
 *
 * Keyed on the canonical SIGNATURE -- so on `topic0`, which is its hash --
 * because that is what a log carries. Keying on the NAME made two versions of
 * one event across an upgrade, and two contracts declaring same-named events,
 * look like a clash they are not: `Transfer(address,address,uint256)` and
 * `Transfer(address,address,uint256,bytes)` have different topic0s and are
 * trivially told apart on the wire, so both are kept and both are requested.
 *
 * A shared topic0 with a different DEFINITION is the genuine ambiguity, and it
 * is refused here, at construction, naming both declarations. No block boundary
 * resolves it either: an upgrade transaction sits mid-block, so both meanings
 * share a block.
 *
 * What this must never do again is DROP one silently. A spliced event's topic0
 * never entered the fetch filter, so its logs were never asked for, and
 * afterwards nothing distinguished "the chain had none" from "we never asked"
 * -- an absence inferred from a request that was never made, the same failure
 * class as `absence` vs `contradiction` in the reorg model.
 */
function deleteDuplicateEvents(events: AbiEvent[]) {
	const declaredPerSignature = new Map<string, AbiEvent>();
	for (let i = 0; i < events.length; i++) {
		const event = events[i];
		const signature = toEventSignature(event);
		const declared = declaredPerSignature.get(signature);
		if (!declared) {
			declaredPerSignature.set(signature, event);
			continue;
		}
		if (!deepEqual(decodingShapeOf(event), decodingShapeOf(declared))) {
			const topic0 = topic0Of(event);
			throw new Error(
				`ambiguous ABI: "${signature}" is declared more than once with different definitions, ` +
					(topic0
						? `so both arrive under topic0 ${topic0} and nothing on the wire tells them apart. `
						: `and being anonymous they carry no topic0 to tell them apart. `) +
					`Declared as \`${describeEventDeclaration(declared)}\` and as \`${describeEventDeclaration(event)}\`. ` +
					`Make the two declarations identical, or index only one of them.`,
			);
		}
		// the same event, declared twice: collapse it, which is not a loss
		events.splice(i, 1);
		i--;
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

export class LogEventFetcher<ABI extends Abi> extends RangeLogFetcher {
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
		// a NAME can cover several topic0s (two versions of one event, or two
		// contracts declaring the same name differently), and the filter config is
		// keyed by name, so this is a list and not a single topic
		const _topicsPerEventName: Map<string, `0x${string}`[]> = new Map();
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

		// the SAME rule on every list, so which events exist can never depend on
		// `parseAllEventsIrrespectiveOfAddresses` -- a parse-config flag deciding
		// that was the defect
		for (const abiAtAddress of _abiPerAddress.values()) {
			deleteDuplicateEvents(abiAtAddress);
		}
		deleteDuplicateEvents(_allABIEvents);

		const eventNameTopics: EIP1193DATA[] = [];
		for (const item of _allABIEvents) {
			const topic0 = topic0Of(item);
			if (!topic0) {
				// an anonymous event carries no topic0, so there is nothing to put in
				// the filter and nothing to key a filter list by
				continue;
			}
			if (_abiEventPerTopic.get(topic0)) {
				// unreachable: `deleteDuplicateEvents` already collapsed or refused
				// every shared topic0. Kept because the map below decodes by it.
				throw new Error(`duplicate topics found for \`${describeEventDeclaration(item)}\``);
			}
			_abiEventPerTopic.set(topic0, item);
			eventNameTopics.push(topic0);
			const topicsForThatName = _topicsPerEventName.get(item.name);
			if (topicsForThatName) {
				topicsForThatName.push(topic0);
			} else {
				_topicsPerEventName.set(item.name, [topic0]);
			}
		}

		if (parseConfig?.filters) {
			const filters: ExtraFilters = {};
			for (const eventName of Object.keys(parseConfig.filters)) {
				const filterList = parseConfig.filters[eventName];
				// a filter is configured by NAME, so it applies to EVERY topic0 that
				// name covers. Applying it to one of them would leave the others in
				// the shared, unfiltered request -- the same argument filter meaning
				// two different things for two versions of one event
				for (const signatureTopic of _topicsPerEventName.get(eventName) || []) {
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
