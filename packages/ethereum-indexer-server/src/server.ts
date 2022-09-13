import { ContractsInfo } from 'ethereum-indexer';
import path from 'path';
import fs from 'fs';
import { SimpleServer } from './server/simple';
import { loadContracts } from './utils/contracts';

export function runServer(args: {
  deployments?: string;
  processor: string;
  nodeURL: string;
  folder?: string;
  wait: boolean;
  disableCache: boolean;
  disableSecurity: boolean;
  useFSCache: boolean;
}) {
  let contractsData: ContractsInfo | undefined;
  if (args.deployments) {
    contractsData = loadContracts(args.deployments);
  }

  const folder = args.folder ? args.folder : 'ethereum-indexer-data';

  if (!fs.existsSync(folder)) {
    console.info(`folder ${folder} does not exist, creating it...`);
    fs.mkdirSync(folder);
  }

  const processorPath = args.processor.startsWith('.') ? path.resolve(args.processor) : args.processor;

  const server = new SimpleServer({
    contractsData,
    folder,
    processorPath,
    useCache: !args.disableCache,
    useFSCache: args.useFSCache,
    nodeURL: args.nodeURL,
    disableSecurity: args.disableSecurity,
  });

  server.start({ autoIndex: !args.wait });
}
