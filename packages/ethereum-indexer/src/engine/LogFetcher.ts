import {EIP1193Account, EIP1193DATA, EIP1193Log, EIP1193ProviderWithoutEvents} from 'eip-1193';
import {getLogs} from './ethereum';

type InternalLogFetcherConfig = {
	numBlocksToFetchAtStart: number;
	maxBlocksPerFetch: number;
	percentageToReach: number;
	maxEventsPerFetch: number;
	numRetry: number;
};

export type LogsResult = {logs: EIP1193Log[]; toBlockUsed: number};
export type LogsPromise = Promise<LogsResult> & {stopRetrying(): void};

export type LogFetcherConfig = {
	numBlocksToFetchAtStart?: number;
	maxBlocksPerFetch?: number;
	percentageToReach?: number;
	maxEventsPerFetch?: number;
	numRetry?: number;
};

export function getNewToBlockFromError(error: any): number | undefined {
	if (error.code === -32602 && error.message) {
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

	getLogs(options: {fromBlock: number; toBlock: number; retry?: number}): LogsPromise {
		let retry = options.retry !== undefined ? options.retry : this.config.numRetry;
		let _stopRetrying: () => void | undefined;
		const stopRetrying = () => {
			if (_stopRetrying) {
				_stopRetrying();
			}
			retry = 0;
		};
		const promise = new Promise<LogsResult>(async (resolve, reject) => {
			let logs: EIP1193Log[];

			const fromBlock = options.fromBlock;
			let toBlock = Math.min(options.toBlock, fromBlock + this.numBlocksToFetch - 1);

			try {
				logs = await getLogs(this.provider, this.contractAddresses, this.eventNameTopics, {
					fromBlock,
					toBlock,
				});
			} catch (err: any) {
				if (retry <= 0) {
					return reject(err);
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
					if (totalNumOfBlocksThatWasFetched > 1) {
						numBlocksToFetchThisTime = Math.floor(totalNumOfBlocksThatWasFetched / 2);
					} else {
						numBlocksToFetchThisTime = 1;
					}
				}
				// ----------------------------------------------------------------------

				this.numBlocksToFetch = numBlocksToFetchThisTime;

				toBlock = fromBlock + this.numBlocksToFetch - 1;
				const retryPromise = this.getLogs({
					fromBlock,
					toBlock,
					retry: retry - 1,
				});
				_stopRetrying = retryPromise.stopRetrying;
				try {
					const result = await retryPromise;
					logs = result.logs;
					toBlock = result.toBlockUsed;
				} catch (err) {
					return reject(err);
				}
			}

			const targetNumberOfLog = Math.max(
				1,
				Math.floor((this.config.maxEventsPerFetch * this.config.percentageToReach) / 100)
			);
			const totalNumOfBlocksThatWasFetched = toBlock - fromBlock + 1;
			if (logs.length === 0) {
				this.numBlocksToFetch = this.config.maxBlocksPerFetch;
			} else {
				this.numBlocksToFetch = Math.min(
					this.config.maxBlocksPerFetch,
					Math.max(1, Math.floor((targetNumberOfLog * totalNumOfBlocksThatWasFetched) / logs.length))
				);
			}

			resolve({logs, toBlockUsed: toBlock});
		});

		(promise as LogsPromise).stopRetrying = stopRetrying;
		return promise as LogsPromise;
	}
}
