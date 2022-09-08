import { EventFragment, Interface } from '@ethersproject/abi';
import { getAddress } from '@ethersproject/address';
import { InterfaceWithLowerCaseAddresses } from './decoding';

export interface EIP1193RequestArguments {
  readonly method: string;
  readonly params?: readonly unknown[] | object;
}

export interface EIP1193Provider {
  request<T>(args: EIP1193RequestArguments): Promise<T>;
}

export type TransactionData = {
  from: string;
  gasUsed: number;
  status: 0 | 1;
};

export type ETHJSONRPC_TransactionReceipt = {
  from: string;
  gasUsed: string;
  status: 0 | 1;
};

export type JSONType =
  | string
  | number
  | boolean
  | JSONType[]
  | {
      [key: string]: JSONType;
    };

type LogDescription = {
  readonly name: string;
  readonly signature: string;
  readonly topic: string;
  readonly args: Result;
};

export type RawLog = {
  blockNumber: string; // 0x
  blockHash: string;
  transactionIndex: string; // 0x

  removed: boolean;

  address: string;
  data: string;

  topics: Array<string>;

  transactionHash: string;
  logIndex: string; //0x
};
interface Log {
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

export interface LogEvent extends Log {
  name?: string;
  topic?: string;
  signature?: string;
  args?: { [key: string | number]: string | number | boolean };
  // If parsing the arguments failed, this is the error
  decodeError?: Error;
  extra?: JSONType;
  blockTimestamp?: number;
  transaction?: TransactionData;
}

interface Result extends ReadonlyArray<any> {
  readonly [key: string]: any;
}

export type LogFetcherConfig = {
  numBlocksToFetchAtStart?: number;
  maxBlocksPerFetch?: number;
  percentageToReach?: number;
  maxEventsPerFetch?: number;
  numRetry?: number;
};

type InternalLogFetcherConfig = {
  numBlocksToFetchAtStart: number;
  maxBlocksPerFetch: number;
  percentageToReach: number;
  maxEventsPerFetch: number;
  numRetry: number;
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
  protected config: InternalLogFetcherConfig;
  protected numBlocksToFetch: number;
  constructor(
    protected provider: EIP1193Provider,
    protected contractAddresses: string[] | null,
    protected eventNameTopics: (string | string[])[] | null,
    config: LogFetcherConfig = {},
  ) {
    this.config = Object.assign(
      {
        numBlocksToFetchAtStart: 50,
        percentageToReach: 80,
        maxEventsPerFetch: 10000,
        maxBlocksPerFetch: 100000,
        numRetry: 3,
      },
      config,
    );
    this.numBlocksToFetch = Math.min(this.config.numBlocksToFetchAtStart, this.config.maxBlocksPerFetch);
  }

  async getLogs(options: {
    fromBlock: number;
    toBlock: number;
    retry?: number;
  }): Promise<{ logs: RawLog[]; toBlockUsed: number }> {
    let logs: RawLog[];

    const fromBlock = options.fromBlock;
    let toBlock = Math.min(options.toBlock, fromBlock + this.numBlocksToFetch - 1);

    const retry = options.retry !== undefined ? options.retry : this.config.numRetry;

    try {
      logs = await getLogs(this.provider, this.contractAddresses, this.eventNameTopics, {
        fromBlock,
        toBlock,
      });
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
        if (totalNumOfBlocksThatWasFetched > 1) {
          numBlocksToFetchThisTime = Math.floor(totalNumOfBlocksThatWasFetched / 2);
        } else {
          numBlocksToFetchThisTime = 1;
        }
      }
      // ----------------------------------------------------------------------

      this.numBlocksToFetch = numBlocksToFetchThisTime;

      toBlock = fromBlock + this.numBlocksToFetch - 1;
      const result = await this.getLogs({
        fromBlock,
        toBlock,
        retry: retry - 1,
      });
      logs = result.logs;
      toBlock = result.toBlockUsed;
    }

    const targetNumberOfLog = Math.max(
      1,
      Math.floor((this.config.maxEventsPerFetch * this.config.percentageToReach) / 100),
    );
    const totalNumOfBlocksThatWasFetched = toBlock - fromBlock + 1;
    if (logs.length === 0) {
      this.numBlocksToFetch = this.config.maxBlocksPerFetch;
    } else {
      this.numBlocksToFetch = Math.min(
        this.config.maxBlocksPerFetch,
        Math.max(1, Math.floor((targetNumberOfLog * totalNumOfBlocksThatWasFetched) / logs.length)),
      );
    }

    return { logs, toBlockUsed: toBlock };
  }
}

export class LogEventFetcher extends LogFetcher {
  protected contracts: { address: string; interface: Interface }[] | Interface;
  constructor(
    provider: EIP1193Provider,
    contractsData: { address: string; eventsABI: any[] }[] | { eventsABI: any[] },
    config: LogFetcherConfig = {},
  ) {
    let contracts: { address: string; interface: Interface }[] | Interface;
    let contractAddresses: string[] | null = null;
    let eventABIS: Interface[];
    if (Array.isArray(contractsData)) {
      contracts = contractsData.map((v) => ({
        address: v.address,
        interface: new InterfaceWithLowerCaseAddresses(v.eventsABI),
      }));
      contractAddresses = contracts.map((v) => v.address);
      eventABIS = contracts.map((v) => v.interface);
    } else {
      contracts = new InterfaceWithLowerCaseAddresses(contractsData.eventsABI);
      eventABIS = [contracts];
    }

    let eventNameTopics: string[] | null = null;
    for (const contract of eventABIS) {
      for (const fragment of contract.fragments) {
        if (fragment.type === 'event') {
          const eventFragment = fragment as EventFragment;
          const topic = contract.getEventTopic(eventFragment);
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

  async getLogEvents(options: {
    fromBlock: number;
    toBlock: number;
    retry?: number;
  }): Promise<{ events: LogEvent[]; toBlockUsed: number }> {
    const { logs, toBlockUsed } = await this.getLogs(options);
    const events = this.parse(logs);
    return { events, toBlockUsed };
  }

  parse(logs: RawLog[]): LogEvent[] {
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
        let parsed: LogDescription | null = null;
        try {
          parsed = correspondingContract.parseLog(log);
        } catch (e) {}

        if (parsed) {
          // Successfully parsed the event log; include it
          const args: { [key: string | number]: string | number } = {};
          const parsedArgsKeys = Object.keys(parsed.args);
          for (const key of parsedArgsKeys) {
            // BigNumber to be represented as decimal string
            let value = parsed.args[key];
            if ((value as { _isBigNumber?: boolean; toString(): string })._isBigNumber) {
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

export async function getBlockNumber(provider: EIP1193Provider): Promise<number> {
  const blockAsHexString = await send<any, string>(provider, 'eth_blockNumber', []);
  return parseInt(blockAsHexString.slice(2), 16);
}

// NOTE: only interested in the timestamp for now
export async function getBlock(provider: EIP1193Provider, hash: string): Promise<{ timestamp: number }> {
  const blockWithHexStringFields = await send<any, { timestamp: string }>(provider, 'eth_getBlockByHash', [
    hash,
    false,
  ]);
  return {
    timestamp: parseInt(blockWithHexStringFields.timestamp.slice(2), 16),
  };
}

// NOTE: only interested in the timestamp for now
export async function getBlocks(provider: EIP1193Provider, hashes: string[]): Promise<{ timestamp: number }[]> {
  const requests: { method: string; params: [string, boolean] }[] = [];
  for (const hash of hashes) {
    requests.push({
      method: 'eth_getBlockByHash',
      params: [hash, false],
    });
  }
  const blocksWithHexStringFields = await batch(provider, requests);

  return blocksWithHexStringFields.map((block) => ({
    timestamp: parseInt(block.timestamp.slice(2), 16),
  }));
}

export async function getTransactionReceipt(provider: EIP1193Provider, hash: string): Promise<TransactionData> {
  const transactionReceiptWithHexStringFields = await send<any, ETHJSONRPC_TransactionReceipt>(
    provider,
    'eth_getTransactionReceipt',
    [hash],
  );
  return {
    from: transactionReceiptWithHexStringFields.from,
    gasUsed: parseInt(transactionReceiptWithHexStringFields.gasUsed.slice(2), 16),
    status: transactionReceiptWithHexStringFields.status,
  };
}

export async function getTransactionReceipts(provider: EIP1193Provider, hashes: string[]): Promise<TransactionData[]> {
  const requests: { method: string; params: [string] }[] = [];
  for (const hash of hashes) {
    requests.push({
      method: 'eth_getTransactionReceipt',
      params: [hash],
    });
  }
  const transactionReceiptsWithHexStringFields = await batch(provider, requests);

  return transactionReceiptsWithHexStringFields.map((transaction) => ({
    from: transaction.from,
    gasUsed: parseInt(transaction.gasUsed.slice(2), 16),
    status: transaction.status,
  }));
}

export async function getLogs(
  provider: EIP1193Provider,
  contractAddresses: string[] | null,
  eventNameTopics: (string | string[])[] | null,
  options: { fromBlock: number; toBlock: number },
): Promise<RawLog[]> {
  const logs: RawLog[] = await send<any, RawLog[]>(provider, 'eth_getLogs', [
    {
      address: contractAddresses,
      fromBlock: '0x' + options.fromBlock.toString(16),
      toBlock: '0x' + options.toBlock.toString(16),
      topics: eventNameTopics ? [eventNameTopics] : undefined,
    },
  ]);
  return logs;
}

export async function send<U extends any[], T>(provider: EIP1193Provider, method: string, params: U): Promise<T> {
  return await provider.request({
    method,
    params,
  });
}

export async function batch(provider: EIP1193Provider, requests: { method: string; params: any[] }[]): Promise<any[]> {
  return send<any, any[]>(provider, 'eth_batch', requests);
}

const multicallInterface = new InterfaceWithLowerCaseAddresses([
  {
    inputs: [
      {
        internalType: 'contract IERC165[]',
        name: 'contracts',
        type: 'address[]',
      },
      {
        internalType: 'bytes4',
        name: 'interfaceId',
        type: 'bytes4',
      },
    ],
    name: 'supportsInterface',
    outputs: [
      {
        internalType: 'bool[]',
        name: 'result',
        type: 'bool[]',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'contract IERC165[]',
        name: 'contracts',
        type: 'address[]',
      },
      {
        internalType: 'bytes4[]',
        name: 'interfaceIds',
        type: 'bytes4[]',
      },
    ],
    name: 'supportsMultipleInterfaces',
    outputs: [
      {
        internalType: 'bool[]',
        name: 'result',
        type: 'bool[]',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
]);

export function getmMulti165CallData(contractAddresses: string[]): {
  to: string;
  data: string;
} {
  const data = multicallInterface.encodeFunctionData('supportsInterface', [contractAddresses, '0x80ac58cd']);
  return { to: '0x9f83e74173A34d59D0DFa951AE22336b835AB196', data };
}

export async function multi165(provider: EIP1193Provider, contractAddresses: string[]): Promise<boolean[]> {
  const callData = getmMulti165CallData(contractAddresses);
  // TODO specify blockHash for event post the deployment of Multi165 ?
  const response = await send<any, string>(provider, 'eth_call', [
    { ...callData, gas: '0x' + (28000000).toString(16) },
  ]);
  const result: boolean[] = multicallInterface.decodeFunctionResult('supportsInterface', response)[0];
  return result;
}

export async function splitCallAndJoin(provider: EIP1193Provider, contractAddresses: string[]) {
  let result: boolean[] = [];
  const len = contractAddresses.length;
  let start = 0;
  while (start < len) {
    const end = Math.min(start + 800, len);
    const addresses = contractAddresses.slice(start, end);
    const tmp = await multi165(provider, addresses);
    result = result.concat(tmp);
    start = end;
  }
  return result;
}

export function createER721Filter(
  provider: EIP1193Provider,
  options?: { skipUnParsedEvents?: boolean },
): (eventsFetched: LogEvent[]) => Promise<LogEvent[]> {
  const erc721Contracts: { [address: string]: boolean } = {};
  return async (eventsFetched: LogEvent[]): Promise<LogEvent[]> => {
    const addressesMap: { [address: string]: true } = {};
    const addressesToCheck: string[] = [];

    if (options?.skipUnParsedEvents) {
      eventsFetched = eventsFetched.filter((v) => !!v.args);
    }

    for (const event of eventsFetched) {
      if (!erc721Contracts[event.address.toLowerCase()] && !addressesMap[event.address.toLowerCase()]) {
        addressesToCheck.push(event.address);
        addressesMap[event.address.toLowerCase()] = true;
      }
    }
    if (addressesToCheck.length > 0) {
      const responses = await splitCallAndJoin(provider, addressesToCheck);
      for (let i = 0; i < addressesToCheck.length; i++) {
        erc721Contracts[addressesToCheck[i]] = responses[i];
      }
    }

    const events = [];
    for (const event of eventsFetched) {
      const inCache = erc721Contracts[event.address.toLowerCase()];
      if (inCache === true) {
        events.push(event);
        continue;
      } else if (inCache === false) {
        continue;
      }
    }
    return events;
  };
}

const tokenURIInterface = new InterfaceWithLowerCaseAddresses([
  {
    inputs: [
      {
        internalType: 'uint256',
        name: 'id',
        type: 'uint256',
      },
    ],
    name: 'tokenURI',
    outputs: [
      {
        internalType: 'string',
        name: '',
        type: 'string',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
]);

export async function tokenURI(
  provider: EIP1193Provider,
  contract: string,
  tokenID: string,
  blockHash: string,
): Promise<string> {
  const data = tokenURIInterface.encodeFunctionData('tokenURI', [tokenID]);
  const response = await send<any, string>(provider, 'eth_call', [{ to: contract, data }, { blockHash }]);
  const result: string = tokenURIInterface.decodeFunctionResult('tokenURI', response)[0];
  return result;
}

export function createER721TokenURIFetcher(
  provider: EIP1193Provider,
): (event: LogEvent) => Promise<JSONType | undefined> {
  return async (event: LogEvent): Promise<JSONType | undefined> => {
    if (
      !event.args ||
      !event.args['tokenId'] ||
      !event.args['from'] ||
      event.args['from'] !== '0x0000000000000000000000000000000000000000'
    ) {
      return undefined;
    }

    try {
      const uri = await tokenURI(provider, event.address, event.args['tokenId'] as string, event.blockHash);
      if (uri) {
        return {
          tokenURIAtMint: uri,
        };
      }
    } catch (e) {}
    return undefined;
  };
}
