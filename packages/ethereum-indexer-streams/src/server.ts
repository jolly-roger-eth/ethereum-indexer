import fs from 'fs';
import {MultiStreamServer} from './server/multiStreams';

export function runServer(args: {folder?: string; wait: boolean; disableSecurity: boolean; port?: string}) {
	const folder = args.folder ? args.folder : 'ethereum-indexer-data';

	if (!fs.existsSync(folder)) {
		console.info(`folder ${folder} does not exist, creating it...`);
		fs.mkdirSync(folder);
	}

	const server = new MultiStreamServer({
		folder,
		disableSecurity: args.disableSecurity,
		port: args.port ? parseInt(args.port) : undefined,
	});

	server.start({autoIndex: !args.wait});
}
