import {EIP1193Account, EIP1193DATA, EIP1193ProviderWithoutEvents} from 'eip-1193';
import {IncludedEIP1193Log} from '../../types';
import {UnlessCancelledFunction} from '../utils/promises';
import {ExtraFilters, getLogs, getLogsWithVariousFilters} from './ethereum';

type InternalLogFetcherConfig = {
	numBlocksToFetchAtStart: number;
	maxBlocksPerFetch: number;
	percentageToReach: number;
	maxEventsPerFetch: number;
	numRetry: number;
};

export type LogsResult = {logs: IncludedEIP1193Log[]; toBlockUsed: number};

export type LogFetcherConfig = {
	numBlocksToFetchAtStart?: number;
	maxBlocksPerFetch?: number;
	percentageToReach?: number;
	maxEventsPerFetch?: number;
	numRetry?: number;
	filters?: ExtraFilters;
};

export function getNewToBlockFromError(error: any): number | undefined {
	if (error.code === -32005 || (error.code === -32602 && error.message)) {
		if (error.message.startsWith('query returned more than 10000 results.')) {
			// query returned more than 10000 results. Try with this block range [0xEC23E8, 0xEC23F5].
			console.error(error.message);
		}
		const regex = /\[.*\]/gm;
		const result = regex.exec(error.message);
		let values: number[] | undefined;
		if (result && result[0]) {
			values = result[0]
				.slice(1, result[0].length - 1)
				.split(', ')
				.map((v) => parseInt(v.slice(2), 16));
		}

		if (values && !isNaN(values[1])) {
			return values[1];
		}
	}
	return undefined;
}

export class LogFetcher {
	protected readonly config: InternalLogFetcherConfig;
	protected numBlocksToFetch: number;
	protected foundNumBlockToHigh: number | undefined;
	protected safeNumBlock: number | undefined;
	constructor(
		protected provider: EIP1193ProviderWithoutEvents,
		protected contractAddresses: EIP1193Account[] | null,
		protected eventNameTopics: EIP1193DATA[] | null,
		readonly conf: LogFetcherConfig = {}
	) {
		this.config = Object.assign(
			{
				numBlocksToFetchAtStart: 50,
				percentageToReach: 80,
				maxEventsPerFetch: 10000,
				maxBlocksPerFetch: 100000,
				numRetry: 3,
			},
			conf
		);
		this.numBlocksToFetch = Math.min(this.config.numBlocksToFetchAtStart, this.config.maxBlocksPerFetch);
	}

	async getLogs(
		options: {fromBlock: number; toBlock: number; retry?: number},
		unlessCancelled: UnlessCancelledFunction
	): Promise<LogsResult> {
		let retry = options.retry !== undefined ? options.retry : this.config.numRetry;
		let logs: IncludedEIP1193Log[];

		const fromBlock = options.fromBlock;
		let toBlock = Math.min(options.toBlock, fromBlock + this.numBlocksToFetch - 1);
		try {
			if (this.conf.filters) {
				logs = await getLogsWithVariousFilters(
					this.provider,
					this.contractAddresses,
					this.eventNameTopics,
					this.conf.filters,
					{
						fromBlock,
						toBlock,
					},
					unlessCancelled
				);
			} else {
				logs = await unlessCancelled(
					getLogs(this.provider, this.contractAddresses, this.eventNameTopics ? [this.eventNameTopics] : null, {
						fromBlock,
						toBlock,
					})
				);
			}
		} catch (err: any) {
			if (retry <= 0) {
				throw err;
			}
			let numBlocksToFetchThisTime = this.numBlocksToFetch;
			// ----------------------------------------------------------------------
			// compute the new number of block to fetch this time:
			// ----------------------------------------------------------------------
			const toBlockClue = getNewToBlockFromError(err);
			if (toBlockClue) {
				const totalNumOfBlocksToFetch = toBlockClue - fromBlock + 1;
				if (totalNumOfBlocksToFetch > 1) {
					numBlocksToFetchThisTime = Math.floor((totalNumOfBlocksToFetch * this.config.percentageToReach) / 100);
				}
			} else {
				const totalNumOfBlocksThatWasFetched = toBlock - fromBlock;
				// "block range too large"
				if (
					err.code === -32603 &&
					err.data &&
					err.data.message
				) {
					if (err.data.message.indexOf('block range is too wide') !== -1) {
						// found on polygon rpc
						this.foundNumBlockToHigh = Math.min(
							this.foundNumBlockToHigh || this.config.maxBlocksPerFetch,
							totalNumOfBlocksThatWasFetched
						);
					} else if (err.data.message.indexOf("block range too large")) {
						// found on base rpc
						this.foundNumBlockToHigh = Math.min(
							this.foundNumBlockToHigh || this.config.maxBlocksPerFetch,
							totalNumOfBlocksThatWasFetched
						);
					}
				}

				if (totalNumOfBlocksThatWasFetched > 1) {
					numBlocksToFetchThisTime = Math.floor(totalNumOfBlocksThatWasFetched / 2);
				} else {
					numBlocksToFetchThisTime = 1;
				}
			}
			// ----------------------------------------------------------------------

			this.numBlocksToFetch = numBlocksToFetchThisTime;
			if (this.foundNumBlockToHigh && this.foundNumBlockToHigh < this.numBlocksToFetch) {
				if (this.safeNumBlock) {
					this.numBlocksToFetch = Math.min(
						Math.floor((this.foundNumBlockToHigh - this.safeNumBlock) / 2),
						this.foundNumBlockToHigh - 1
					);
				} else {
					this.numBlocksToFetch = this.foundNumBlockToHigh - 1;
				}
			}

			toBlock = fromBlock + this.numBlocksToFetch - 1;
			const result = await this.getLogs(
				{
					fromBlock,
					toBlock,
					retry: retry - 1,
				},
				unlessCancelled
			);
			logs = result.logs;
			toBlock = result.toBlockUsed;
		}

		const targetNumberOfLog = Math.max(
			1,
			Math.floor((this.config.maxEventsPerFetch * this.config.percentageToReach) / 100)
		);
		const totalNumOfBlocksThatWasFetched = toBlock - fromBlock + 1;

		this.safeNumBlock = Math.max(this.safeNumBlock || 0, totalNumOfBlocksThatWasFetched);

		if (this.foundNumBlockToHigh) {
			if (this.safeNumBlock) {
				this.numBlocksToFetch = Math.min(
					this.safeNumBlock + Math.floor((this.foundNumBlockToHigh - this.safeNumBlock) / 2),
					this.foundNumBlockToHigh - 1
				);
			} else {
				this.numBlocksToFetch = this.foundNumBlockToHigh - 1;
			}
		} else {
			if (logs.length === 0) {
				this.numBlocksToFetch = this.config.maxBlocksPerFetch;
			} else {
				this.numBlocksToFetch = Math.min(
					this.config.maxBlocksPerFetch,
					Math.max(1, Math.floor((targetNumberOfLog * totalNumOfBlocksThatWasFetched) / logs.length))
				);
			}
		}

		return {logs, toBlockUsed: toBlock};
	}
}
