import {
  EIP1193Provider,
  getBlock,
  getBlockNumber,
  getBlocks,
  getTransactionReceipt,
  getTransactionReceipts,
  LogEvent,
  LogEventFetcher,
  LogFetcherConfig,
  TransactionData,
} from './engine/ethereum';

import { logs } from 'named-logs';
const console = logs('ethereum-indexer');

export {
  EIP1193Provider,
  LogEvent,
  EIP1193RequestArguments,
  RawLog,
  LogEventFetcher,
  LogFetcher,
  LogFetcherConfig,
} from './engine/ethereum';

export type EventProcessor = {
  load: (contractsData: ContractsInfo) => Promise<LastSync>;
  process: (eventStream: EventWithId[], lastSync: LastSync) => Promise<void>;
  reset: () => Promise<void>;
  filter?: (eventsFetched: LogEvent[]) => Promise<LogEvent[]>;
  shouldFetchTimestamp?: (event: LogEvent) => boolean;
  shouldFetchTransaction?: (event: LogEvent) => boolean;
};

export type EventBlock = {
  number: number;
  hash: string;
  events: LogEvent[];
};

export type LastSync = {
  latestBlock: number;
  lastToBlock: number;
  unconfirmedBlocks: EventBlock[];
  nextStreamID: number;
};

export type EventWithId = LogEvent & {
  streamID: number;
};

export type BlockEvents = { hash: string; number: number; events: LogEvent[] };

export type ContractData = {
  eventsABI: any[];
  address: string;
  startBlock?: number;
};

export type AllContractData = { eventsABI: any[]; startBlock?: number };

export type ContractsInfo = ContractData[] | AllContractData;

export type IndexerConfig = LogFetcherConfig & {
  finality?: number;
  alwaysFetchTimestamps?: boolean;
  alwaysFetchTransactions?: boolean;
  providerSupportsETHBatch?: boolean;
};

export class EthereumIndexer {
  protected logEventFetcher: LogEventFetcher;
  protected lastSync: LastSync | undefined;
  protected finality: number;
  public readonly defaultFromBlock: number;
  protected alwaysFetchTimestamps: boolean;
  protected alwaysFetchTransactions: boolean;
  protected providerSupportsETHBatch: boolean;
  constructor(
    protected provider: EIP1193Provider,
    protected processor: EventProcessor,
    protected contractsData: ContractsInfo,
    config: IndexerConfig = {},
  ) {
    this.finality = config.finality || 12;
    this.logEventFetcher = new LogEventFetcher(provider, contractsData, config);
    this.alwaysFetchTimestamps = config.alwaysFetchTimestamps ? true : false;
    this.alwaysFetchTransactions = config.alwaysFetchTransactions ? true : false;

    this.providerSupportsETHBatch = config.providerSupportsETHBatch as boolean;

    this.defaultFromBlock = 0;
    if (Array.isArray(this.contractsData)) {
      for (const contractData of this.contractsData) {
        if (contractData.startBlock) {
          if (this.defaultFromBlock === 0) {
            this.defaultFromBlock = contractData.startBlock;
          } else if (contractData.startBlock < this.defaultFromBlock) {
            this.defaultFromBlock = contractData.startBlock;
          }
        }
      }
    } else {
      this.defaultFromBlock = this.contractsData.startBlock || 0;
    }
  }

  protected _loading: Promise<LastSync> | undefined;
  async promiseToLoad(): Promise<LastSync> {
    try {
      if (!this.lastSync) {
        this.lastSync = await this.processor.load(this.contractsData);
      }
      return this.lastSync;
    } finally {
      this._loading = undefined;
    }
  }

  async load(): Promise<LastSync> {
    if (!this._loading) {
      this._loading = this.promiseToLoad();
    }
    return this._loading;
  }

  protected _reseting: Promise<void> | undefined;
  async reset() {
    if (this._reseting) {
      return this._reseting;
    }
    this._reseting = new Promise(async (resolve, reject) => {
      this._processing = undefined; // abort processing if any, see `indexMore`
      this.lastSync = {
        lastToBlock: 0,
        latestBlock: 0,
        nextStreamID: 1,
        unconfirmedBlocks: [],
      };
      try {
        await this.processor.reset();
        this._reseting = undefined;
        resolve();
      } catch (err) {
        this._reseting = undefined;
        reject(err);
      }
    });
    return this._reseting;
  }

  async promiseToFeed(eventStream: EventWithId[]): Promise<LastSync> {
    try {
      const lastSync: LastSync = this.lastSync;

      const firstEvent = eventStream[0];
      const lastEvent = eventStream[eventStream.length - 1];

      const latestBlock = await getBlockNumber(this.provider);

      if (latestBlock - lastEvent.blockNumber < this.finality) {
        throw new Error('do not accept unconfirmed blocks');
      }

      if (firstEvent.streamID === lastSync.nextStreamID) {
        const newLastSync = {
          latestBlock: latestBlock,
          lastToBlock: lastEvent.blockNumber,
          unconfirmedBlocks: [],
          nextStreamID: lastEvent.streamID + 1,
        };
        await this.processor.process(eventStream, newLastSync);
        this.lastSync = newLastSync;
      } else {
        throw new Error(`invalid nextStreamID, ${firstEvent.streamID} === ${lastSync.nextStreamID}`);
      }
      return this.lastSync;
    } finally {
      this._processing = undefined;
    }
  }

  async feed(eventStream: EventWithId[]): Promise<LastSync> {
    if (this._processing) {
      throw new Error(`processing... should not feed`);
    }
    if (this._reseting) {
      throw new Error(`reseting... should not feed`);
    }

    this._processing = this.promiseToFeed(eventStream);
    return this._processing;
  }

  protected _processing: Promise<LastSync> | undefined;
  indexMore(): Promise<LastSync> {
    if (this._processing) {
      console.info(`still processing...`);
      return this._processing;
    }

    if (this._reseting) {
      console.info(`reseting...`);
      this._processing = this._reseting.then(() => this.promiseToIndex());
    } else {
      console.info(`go!`);
      this._processing = this.promiseToIndex();
    }
    return this._processing;
  }

  async getBlocks(blockHashes: string[]): Promise<{ timestamp: number }[]> {
    if (this.providerSupportsETHBatch) {
      return getBlocks(this.provider, blockHashes);
    } else {
      const result = [];
      for (const blockHash of blockHashes) {
        console.info(`getting block ${blockHash}...`);
        const actualBlock = await getBlock(this.provider, blockHash);
        if (!this._processing) {
          return;
        }
        result.push(actualBlock);
      }
      return result;
    }
  }

  async getTransactions(transactionHashes: string[]): Promise<TransactionData[]> {
    if (this.providerSupportsETHBatch) {
      return getTransactionReceipts(this.provider, transactionHashes);
    } else {
      const result = [];
      for (const transactionHash of transactionHashes) {
        console.info(`getting block ${transactionHash}...`);
        const tx = await getTransactionReceipt(this.provider, transactionHash);
        if (!this._processing) {
          return;
        }
        result.push(tx);
      }
      return result;
    }
  }

  protected promiseToIndex(): Promise<LastSync> {
    return new Promise(async (resolve, reject) => {
      try {
        if (!this.lastSync) {
          console.info(`load lastSync...`);
          await this.load();
        }
        const lastSync = this.lastSync as LastSync;

        const unconfirmedBlocks = lastSync.unconfirmedBlocks;
        let streamID = lastSync.nextStreamID;

        let fromBlock = this.defaultFromBlock;
        if (unconfirmedBlocks.length > 0) {
          fromBlock = lastSync.unconfirmedBlocks[0].number;
        } else {
          if (lastSync.lastToBlock !== 0) {
            fromBlock = lastSync.lastToBlock + 1;
          }
        }

        console.info(`getting latest block...`);
        const latestBlock = await getBlockNumber(this.provider);

        if (!this._processing) {
          console.info(`not processing anymore...`);
          reject('aborted');
          return;
        }

        let toBlock = latestBlock;

        if (fromBlock > toBlock) {
          console.info(`no new block`);
          this._processing = undefined;
          return resolve(lastSync);
        }

        const { events: eventsFetched, toBlockUsed: newToBlock } = await this.logEventFetcher.getLogEvents({
          fromBlock,
          toBlock: toBlock,
        });
        toBlock = newToBlock;

        if (!this._processing) {
          console.info(`not processing anymore...`);
          reject('aborted');
          return;
        }

        const blockTimestamps: { [hash: string]: number } = {};
        const transactions: { [hash: string]: TransactionData } = {};
        let anyFetch = false;

        const blockHashes: string[] = [];
        const transactionHashes: string[] = [];
        let lastBlock;
        let lastTransactionHash;
        for (const event of eventsFetched) {
          let fetchTransaction = false;
          let fetchBlock = false;

          if (
            this.alwaysFetchTransactions ||
            (this.processor.shouldFetchTransaction && this.processor.shouldFetchTransaction(event))
          ) {
            if (lastTransactionHash !== event.transactionHash) {
              fetchTransaction = true;
            }
          }

          if (
            this.alwaysFetchTimestamps ||
            (this.processor.shouldFetchTimestamp && this.processor.shouldFetchTimestamp(event))
          ) {
            if (!lastBlock || event.blockNumber > lastBlock) {
              fetchBlock = true;
            }
          }

          if (fetchTransaction) {
            lastTransactionHash = event.transactionHash;
            transactionHashes.push(event.transactionHash);
          }
          if (fetchBlock) {
            lastBlock = event.blockNumber;
            blockHashes.push(event.blockHash);
          }
        }
        if (blockHashes.length > 0) {
          console.info(`fetching a batch of  ${blockHashes.length} blocks...`);
          const blocks = await this.getBlocks(blockHashes);
          console.info(`...got  ${blocks.length} blocks back`);
          if (!this._processing) {
            console.info(`not processing anymore...`);
            reject('aborted');
            return;
          }

          for (let i = 0; i < blockHashes.length; i++) {
            blockTimestamps[blockHashes[i]] = blocks[i].timestamp;
          }
          anyFetch = true;
        }

        if (transactionHashes.length > 0) {
          console.info(`fetching a batch of ${transactionHashes.length} transactions...`);
          const transactionReceipts = await this.getTransactions(transactionHashes);
          console.info(`...got ${transactionReceipts.length} transactions back`);
          if (!this._processing) {
            console.info(`not processing anymore...`);
            reject('aborted');
            return;
          }

          for (let i = 0; i < transactionHashes.length; i++) {
            transactions[transactionHashes[i]] = transactionReceipts[i];
          }
          anyFetch = true;
        }

        if (anyFetch) {
          for (const event of eventsFetched) {
            event.transaction = transactions[event.transactionHash];
            event.blockTimestamp = blockTimestamps[event.blockHash];
          }
        }

        let newEvents = eventsFetched;
        if (this.processor.filter) {
          console.info(`filtering...`);
          newEvents = await this.processor.filter(eventsFetched);
        }

        if (!this._processing) {
          console.info(`not processing anymore...`);
          reject('aborted');
          return;
        }

        console.info(`populating stream...`);
        const { eventStream, newLastSync } = await this._generateStreamToAppend(newEvents, {
          latestBlock,
          lastToBlock: toBlock,
          nextStreamID: streamID,
          unconfirmedBlocks,
        });

        if (!this._processing) {
          console.info(`not processing anymore...`);
          reject('aborted');
          return;
        }

        console.info(`PROCESSING`);
        await this.processor.process(eventStream, newLastSync);
        console.info(`DONE`);

        if (!this._processing) {
          console.info(`not processing anymore...`);
          reject('aborted');
          return;
        }

        this.lastSync = newLastSync;

        this._processing = undefined;
        return resolve(newLastSync);
      } catch (e: any) {
        console.info(`error`, e);
        this._processing = undefined;
        return reject(e);
      }
    });
  }

  protected async _generateStreamToAppend(
    newEvents: LogEvent[],
    { latestBlock, lastToBlock, unconfirmedBlocks, nextStreamID }: LastSync,
  ): Promise<{ eventStream: EventWithId[]; newLastSync: LastSync }> {
    // grouping per block...
    const groups: { [hash: string]: BlockEvents } = {};
    const eventsGroupedPerBlock: BlockEvents[] = [];
    for (const event of newEvents) {
      let group = groups[event.blockHash];
      if (!group) {
        group = groups[event.blockHash] = {
          hash: event.blockHash,
          number: event.blockNumber,
          events: [],
        };
        eventsGroupedPerBlock.push(group);
      }
      group.events.push(event);
    }

    // set up the new entries to be added to the stream
    // const newEventEntries: DurableObjectEntries<LogEvent> = {};
    const eventStream: EventWithId[] = [];

    // find reorgs
    let reorgBlock: EventBlock | undefined;
    let reorgedBlockIndex = 0;
    for (const block of eventsGroupedPerBlock) {
      if (reorgedBlockIndex < unconfirmedBlocks.length) {
        const unconfirmedBlockAtIndex = unconfirmedBlocks[reorgedBlockIndex];
        if (unconfirmedBlockAtIndex.hash !== block.hash) {
          reorgBlock = unconfirmedBlockAtIndex;
          break;
        }
        reorgedBlockIndex++;
      }
    }

    if (reorgBlock) {
      // re-add event to the stream but flag them as removed
      for (let i = reorgedBlockIndex; i < unconfirmedBlocks.length; i++) {
        for (const event of unconfirmedBlocks[i].events) {
          eventStream.push({
            ...event,
            streamID: nextStreamID++,
            removed: true,
          });
        }
      }
    }

    const startingBlockForNewEvent = reorgBlock
      ? reorgBlock.number
      : unconfirmedBlocks.length > 0
      ? unconfirmedBlocks[unconfirmedBlocks.length - 1].number + 1
      : eventsGroupedPerBlock.length > 0
      ? eventsGroupedPerBlock[0].number
      : 0;
    // the case for 0 is a void case as none of the loop below will be triggered

    // new events and new unconfirmed blocks
    const newUnconfirmedBlocks: EventBlock[] = [];
    const newUnconfirmedStream: LogEvent[] = [];

    // re-add unconfirmed blocks that might get reorg later still
    for (const unconfirmedBlock of unconfirmedBlocks) {
      if (unconfirmedBlock.number < startingBlockForNewEvent) {
        if (latestBlock - unconfirmedBlock.number <= this.finality) {
          newUnconfirmedBlocks.push(unconfirmedBlock);
        }
      }
    }

    for (const block of eventsGroupedPerBlock) {
      if (block.events.length > 0 && block.number >= startingBlockForNewEvent) {
        for (const event of block.events) {
          eventStream.push({ streamID: nextStreamID++, ...event });
        }
        if (latestBlock - block.number <= this.finality) {
          newUnconfirmedBlocks.push({
            hash: block.hash,
            number: block.number,
            events: block.events,
          });

          for (const event of block.events) {
            // TODO slim the event down ?
            //  remove:
            //  - topics
            //  - data // assuming the event has been parsed succesfully
            //  - args named // indexed based is more universal but named one are easier, choose
            //  - signature
            //  - topic
            newUnconfirmedStream.push({ ...event });
          }
        }
      }
    }

    return {
      eventStream,
      newLastSync: {
        latestBlock,
        lastToBlock,
        unconfirmedBlocks: newUnconfirmedBlocks,
        nextStreamID,
      },
    };
  }
}
