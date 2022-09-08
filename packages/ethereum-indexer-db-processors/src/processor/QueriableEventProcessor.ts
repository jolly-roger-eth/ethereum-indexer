import { EventProcessor } from 'ethereum-indexer';
import { FromDB, JSONObject, Query, Result } from './Database';

export type Queriable = {
  query<T>(request: Query | (Query & ({ blockHash: string } | { blockNumber: number }))): Promise<Result>;

  get<T extends JSONObject>(id: string): Promise<FromDB<T> | null>;
};

export type QueriableEventProcessor = EventProcessor & Queriable;
