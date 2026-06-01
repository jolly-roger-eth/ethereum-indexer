import type {Abi, EventProcessor} from 'ethereum-indexer';
import type {FromDB, JSONObject, Query, Result} from './db/Database.js';

export type Queriable = {
	query<T>(request: Query | (Query & ({blockHash: string} | {blockNumber: number}))): Promise<Result>;

	get<T extends JSONObject>(id: string): Promise<FromDB<T> | null>;
};

export type QueriableEventProcessor<ABI extends Abi, ProcessResultType> = EventProcessor<ABI, ProcessResultType> &
	Queriable;
