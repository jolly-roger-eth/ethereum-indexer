import type {Abi, ExistingStream, LastSync, LogEvent} from 'ethereum-indexer';
import {Database} from '../db/Database';

export async function setupCache<ABI extends Abi>(database: Database): Promise<ExistingStream<ABI>> {
	await database.setup({
		indexes: [{fields: ['blockNumber', 'logIndex']}], // 'blockNumber', 'blockHash', 'address', 'transactionHash', 'name', 'signature', 'topic'
	});

	return {
		async saveNewEvents(source, stream) {
			// TODO make it transactional
			const {eventStream} = stream;
			if (eventStream.length > 0) {
				for (const event of eventStream) {
					await database.put({
						_id: event.blockHash + event.logIndex,
						transactionHash: event.transactionHash,
						logIndex: event.logIndex,
						blockNumber: event.blockNumber,
						blockHash: event.blockHash,
						transactionIndex: event.transactionIndex,
						topics: event.topics,
						removed: event.removed,
						address: event.address,
						eventName: (event as any).eventName,
						data: event.data,
						args: (event as any).args,
						// extra: event.extra, // TODO
					});
				}
			}
			let lastLastSync;
			try {
				lastLastSync = await database.get('lastSync');
			} catch (err) {}
			const lastSyncDoc = {
				_id: 'lastSync',
				_rev: lastLastSync?._rev,
				...stream.lastSync,
			};
			await database.put(lastSyncDoc as any);
		},
		// TODO change ExistingStream api to also provide a toBlock
		// this is to avoid loading all events in memory
		// we can make it an optional arguments, so we can keep as is for now
		async fetchFrom(source, fromBlock) {
			// TODO source for database

			const lastSync = await database.get<LastSync<ABI>>('lastSync');
			if (!lastSync) {
				return undefined;
			}

			const events = (
				await database.query({
					selector: {
						blockNumber: {$gte: fromBlock},
					},
					sort: ['blockNumber', 'logIndex'],
				})
			).docs.filter((v) => v._id !== 'lastSync') as unknown as LogEvent<ABI>[];
			return {
				eventStream: events,
				lastSync,
			};
		},
		async clear(source) {
			database = await database.reset();
		},
	};
}
