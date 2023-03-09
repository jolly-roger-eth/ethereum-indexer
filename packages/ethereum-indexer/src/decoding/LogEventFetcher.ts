import {EventFragment, Interface} from '@ethersproject/abi';
import {getAddress} from '@ethersproject/address';
import {EIP1193Account, EIP1193DATA, EIP1193Log, EIP1193ProviderWithoutEvents} from 'eip-1193';
import {GenericABI} from '../types';
import {InterfaceWithLowerCaseAddresses} from './address';
import {LogTransactionData} from '../engine/ethereum';
import {LogFetcher, LogFetcherConfig} from '../engine/LogFetcher';

export type JSONObject = {
	[key: string]: JSONType;
};

export type JSONType = string | number | boolean | JSONType[] | JSONObject;

interface Result extends ReadonlyArray<any> {
	readonly [key: string]: any;
}

type EthersInterfaceLogDescription = {
	readonly name: string;
	readonly signature: string;
	readonly topic: string;
	readonly args: Result;
};

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

export interface LogEvent<
	Args extends {
		[key: string]: JSONType;
	} = {
		[key: string]: JSONType;
	},
	Extra extends JSONObject = JSONObject
> extends NumberifiedLog {
	name?: string;
	topic?: string;
	signature?: string;
	args?: Args;
	// If parsing the arguments failed, this is the error
	decodeError?: Error;
	extra?: Extra;
	blockTimestamp?: number;
	transaction?: LogTransactionData;
}

export type ParsedLogsResult = {events: LogEvent[]; toBlockUsed: number};
export type ParsedLogsPromise = Promise<ParsedLogsResult> & {stopRetrying(): void};

export class LogEventFetcher extends LogFetcher {
	protected contracts: {address: string; interface: Interface}[] | Interface;
	constructor(
		provider: EIP1193ProviderWithoutEvents,
		contractsData: readonly {readonly address: string; readonly abi: GenericABI}[] | {readonly abi: GenericABI},
		config: LogFetcherConfig = {}
	) {
		let contracts: {address: EIP1193Account; interface: Interface}[] | Interface;
		let contractAddresses: EIP1193Account[] | null = null;
		let eventABIS: Interface[];
		if (Array.isArray(contractsData)) {
			contracts = contractsData.map((v) => ({
				address: v.address as EIP1193Account,
				interface: new InterfaceWithLowerCaseAddresses(v.abi),
			}));
			contractAddresses = contracts.map((v) => v.address);
			eventABIS = contracts.map((v) => v.interface);
		} else {
			contracts = new InterfaceWithLowerCaseAddresses((contractsData as {readonly abi: GenericABI}).abi);
			eventABIS = [contracts];
		}

		let eventNameTopics: EIP1193DATA[] | null = null;
		for (const contract of eventABIS) {
			for (const fragment of contract.fragments) {
				if (fragment.type === 'event') {
					const eventFragment = fragment as EventFragment;
					const topic = contract.getEventTopic(eventFragment) as EIP1193DATA;
					if (topic) {
						eventNameTopics = eventNameTopics || [];
						eventNameTopics.push(topic);
					}
				}
			}
		}

		super(provider, contractAddresses, eventNameTopics, config);
		this.contracts = contracts;
	}

	getLogEvents(options: {fromBlock: number; toBlock: number; retry?: number}): ParsedLogsPromise {
		const logsPromise = this.getLogs(options);
		const promise = logsPromise.then(({logs, toBlockUsed}) => {
			const events = this.parse(logs);
			return {events, toBlockUsed};
		});

		(promise as ParsedLogsPromise).stopRetrying = logsPromise.stopRetrying;
		return promise as ParsedLogsPromise;
	}

	parse(logs: EIP1193Log[]): LogEvent[] {
		const events: LogEvent[] = [];
		for (let i = 0; i < logs.length; i++) {
			const log = logs[i];
			const eventAddress = getAddress(log.address);
			const correspondingContract = !Array.isArray(this.contracts)
				? this.contracts
				: this.contracts.find((v) => v.address.toLowerCase() === eventAddress.toLowerCase())?.interface;
			if (correspondingContract) {
				const event: LogEvent = {
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
				let parsed: EthersInterfaceLogDescription | null = null;
				try {
					parsed = correspondingContract.parseLog(log);
				} catch (e) {}

				if (parsed) {
					// Successfully parsed the event log; include it
					const args: {[key: string | number]: string | number} = {};
					const parsedArgsKeys = Object.keys(parsed.args);
					for (const key of parsedArgsKeys) {
						// BigNumber to be represented as decimal string
						let value = parsed.args[key];
						if ((value as {_isBigNumber?: boolean; toString(): string})._isBigNumber) {
							value = value.toString();
						}
						args[key] = value;
					}
					event.args = args;
					event.name = parsed.name;
					event.signature = parsed.signature;
					event.topic = parsed.topic;
				}

				events.push(event);
			}
		}
		return events;
	}
}
