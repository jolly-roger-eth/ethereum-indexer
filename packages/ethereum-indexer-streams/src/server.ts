import {Abi, IndexingSource} from 'ethereum-indexer';
import fs from 'fs';
import {MultiStreamServer} from './server/multiStreams';
import {loadContracts} from 'ethereum-indexer-utils';

export function runServer<ABI extends Abi>(args: {
	deployments?: string;
	folder?: string;
	wait: boolean;
	disableSecurity: boolean;
	port?: string;
}) {
	let source: IndexingSource<ABI> | undefined;
	if (args.deployments) {
		source = loadContracts(args.deployments);
	}

	const folder = args.folder ? args.folder : 'ethereum-indexer-data';

	if (!fs.existsSync(folder)) {
		console.info(`folder ${folder} does not exist, creating it...`);
		fs.mkdirSync(folder);
	}

	const server = new MultiStreamServer({
		source,
		folder,
		disableSecurity: args.disableSecurity,
		port: args.port ? parseInt(args.port) : undefined,
	});

	server.start({autoIndex: !args.wait});
}
