import {Abi, IndexingSource} from 'ethereum-indexer';
import path from 'path';
import fs from 'fs';
import {SimpleServer} from './server/simple';
import {loadContracts} from './utils/contracts';

export function runServer<ABI extends Abi>(
	processor: string,
	args: {
		deployments?: string;
		processor: string;
		nodeUrl: string;
		folder?: string;
		wait: boolean;
		disableCache: boolean;
		disableSecurity: boolean;
		useFSCache: boolean;
	}
) {
	let source: IndexingSource<ABI> | undefined;
	if (args.deployments) {
		source = loadContracts(args.deployments);
	}

	const folder = args.folder ? args.folder : 'ethereum-indexer-data';

	if (!fs.existsSync(folder)) {
		console.info(`folder ${folder} does not exist, creating it...`);
		fs.mkdirSync(folder);
	}

	const processorPath = processor.startsWith('.') ? path.resolve(processor) : processor;

	let actualPath = processorPath;
	if (fs.statSync(processorPath).isDirectory()) {
		const processorPackage = JSON.parse(fs.readFileSync(`${processorPath}/package.json`, 'utf-8'));
		actualPath = `${processorPath}/${processorPackage.module}`;
	}

	const server = new SimpleServer({
		source,
		folder,
		processorPath: actualPath,
		useCache: !args.disableCache,
		useFSCache: args.useFSCache,
		nodeURL: args.nodeUrl,
		disableSecurity: args.disableSecurity,
	});

	server.start({autoIndex: !args.wait});
}
