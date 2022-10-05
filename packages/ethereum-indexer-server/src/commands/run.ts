import {Command, Flags} from '@oclif/core';
import {runServer} from '../server';

export default class Run extends Command {
	static description = 'Run The Indexer as Server';

	static examples = [
		'<%= config.bin %> <%= command.id %> -p ../../etherplay/conquest-event-processor/dist/index.js -d ../../etherplay/conquest-eth/contracts/deployments/localhost -n http://localhost:8545',
	];

	static flags = {
		version: Flags.version(),
		help: Flags.help(),
		processor: Flags.string({
			char: 'p',
			description: 'path to the event processor module (need to export a field named "processor")',
			required: true,
		}),
		deployments: Flags.string({
			char: 'd',
			description:
				'path the folder containing contract deployments, use hardhat-deploy format, optional if processor provide it',
		}),
		nodeURL: Flags.string({
			char: 'n',
			description: `ethereum's node url (fallback on ETHEREUM_NODE env variable)`,
			required: process.env.ETHEREUM_NODE ? false : true,
		}),
		folder: Flags.string({
			char: 'f',
			description: `where to save the database data`,
		}),
		wait: Flags.boolean({
			description: `server start but indexing wait a POST request to '/start`,
			default: false,
		}),
		disableCache: Flags.boolean({
			description: `disable caching (that caches the event strean so you can replay the event when processor changes instead of having to fetch them again. Note that chaging the contracts data will require a full reset)`,
			default: false,
		}),
		disableSecurity: Flags.boolean({
			description: `ALLOW ANYONE TO CALL ADMIN FUNCTIONS`,
			default: false,
		}),
		useFSCache: Flags.boolean({
			description: `use fs cache to store event stream`,
			default: false,
		}),
	};

	public async run(): Promise<void> {
		const {flags} = await this.parse(Run);
		if (process.env.ETHEREUM_NODE && !flags.nodeURL) {
			flags.nodeURL = process.env.ETHEREUM_NODE;
		}
		runServer(flags as any);
	}
}
