import {Abi, EventProcessor} from 'ethereum-indexer';
import {FromDB, JSONObject, Query, Result} from './db/Database';

export type Queriable = {
	query<T>(request: Query | (Query & ({blockHash: string} | {blockNumber: number}))): Promise<Result>;

	get<T extends JSONObject>(id: string): Promise<FromDB<T> | null>;
};

export type QueriableEventProcessor<ABI extends Abi, ProcessResultType> = EventProcessor<ABI, ProcessResultType> &
	Queriable;
