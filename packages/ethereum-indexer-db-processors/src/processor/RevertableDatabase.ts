import {Abi, LogEvent} from 'ethereum-indexer';
import {
	computeEventID,
	computeArchiveID,
	getID,
	ID,
	Database,
	DBObject,
	FromDB,
	JSONObject,
	PutAndGetDatabaseWithBatchSupport,
	Query,
	Result,
} from 'ethereum-indexer-db-utils';

import {logs} from 'named-logs';
const console = logs('RevertableDatabase');

export type ReversibleDoc = {_id: string; startBlock: number; endBlock: number};

export type BlockWithOnlyNumber = {number: number};
export type Block = BlockWithOnlyNumber & {hash: string};

export class RevertableDatabase<ABI extends Abi> implements PutAndGetDatabaseWithBatchSupport {
	protected currentEvent: LogEvent<ABI> | undefined;
	protected finality: number | undefined;
	constructor(protected db: Database, protected keepAllHistory?: boolean) {}

	setFinality(finality: number) {
		this.finality = finality;
	}

	async deleteBlock(block: {number: number; hash: string}) {
		// delete block
		await this.db.delete(`block_${block.hash}`);
	}

	async prepareBlock(block: {number: number; hash: string}) {
		// TODO create block only if not exist, TODO Database api for this
		await this.db.put({_id: `block_${block.hash}`, number: block.number});
	}

	async postBlock(blockNumber: number) {
		if (!this.keepAllHistory) {
			// we also purge archive as we go
			// This DB do not support time-travel query, except for recent blocks
			const {docs: oldArchives} = await this.db.query({
				selector: {
					endBlock: {$lt: blockNumber - 13},
				},
			});

			// TODO batch, require update Database interface
			for (const archive of oldArchives) {
				await this.db.delete(archive._id);
			}
		}
	}

	async prepareEvent(event: LogEvent<ABI>) {
		this.currentEvent = event;
	}

	async remove(event: LogEvent<ABI>) {
		const eventID = computeEventID(event);

		console.info(`RevertableDatabase Removing / and reverting: ${eventID}...`);

		const {docs} = await this.db.query({
			selector: {
				eventID,
			},
		});

		if (docs.length >= 1) {
			for (const doc of docs as ReversibleDoc[]) {
				// TODO batch ?
				const archiveID = computeArchiveID(doc._id, doc.startBlock - 1);
				const lastArchiveDoc = await this.db.get<ReversibleDoc>(archiveID);
				if (lastArchiveDoc) {
					console.info(`RevertableDatabase, archive found, bringing it back...`);
					lastArchiveDoc._id = doc._id; // replace
					lastArchiveDoc.endBlock = Number.MAX_SAFE_INTEGER;
					await this.db.put(lastArchiveDoc);
					await this.db.delete(archiveID);
				} else {
					console.info(`RevertableDatabase, no archive found, deleting doc...`);
					await this.db.delete(doc._id);
				}
			}
		} else {
			console.error(`RevertableDatabase ERROR: no doc found with eventID: ${eventID}`);
		}
	}

	async put(doc: DBObject): Promise<void> {
		if (!this.currentEvent) {
			throw new Error(`no current event set`);
		}
		console.info(`putting ${doc._id}...`);
		const latestDoc = await this.db.get<ReversibleDoc>(doc._id);
		if (latestDoc && latestDoc.startBlock != this.currentEvent.blockNumber) {
			console.info(`archiving latest ${doc._id} as ended at ${this.currentEvent.blockNumber - 1}`);
			// save last state in the archive
			const archiveID = computeArchiveID(latestDoc._id, this.currentEvent.blockNumber - 1);
			latestDoc._id = archiveID;
			delete (latestDoc as any)._rev; // TODO PouchDB specifity
			await this.db.put({...latestDoc, endBlock: this.currentEvent.blockNumber - 1});
			console.info(`archive complete`);
		}
		console.info(`putting latest...`);
		await this.db.put({
			...doc,
			startBlock: this.currentEvent.blockNumber,
			endBlock: Number.MAX_SAFE_INTEGER,
			eventID: computeEventID(this.currentEvent),
		});
		console.info(`DONE`);
	}

	get<T extends JSONObject>(id: ID): Promise<FromDB<T> | null> {
		// latest keep its id, so nothing to do here
		return this.db.get(id) as Promise<FromDB<T>>;
	}

	async batchGet<T extends JSONObject>(ids: ID[]): Promise<FromDB<T>[]> {
		return this.db.batchGet(ids);
	}

	// slow implementation, to ensure revertability
	async batchPut(objects: DBObject[]): Promise<void> {
		for (const object of objects) {
			await this.put(object);
		}
	}

	// slow implementation, to ensure revertability
	async batchDelete(ids: ID[]): Promise<void> {
		for (const id of ids) {
			await this.delete(id);
		}
	}

	async delete(id: ID): Promise<void> {
		if (!this.currentEvent) {
			throw new Error(`no current event set`);
		}
		console.info(`deleting ${id}...`);
		const latestDoc = await this.db.get<ReversibleDoc>(id);
		if (latestDoc) {
			console.info(`archiving latest ${id} as ended at ${this.currentEvent.blockNumber - 1}`);
			// save last state in the archive
			const archiveID = computeArchiveID(latestDoc._id, this.currentEvent.blockNumber - 1);
			latestDoc._id = archiveID;
			delete (latestDoc as any)._rev; // TODO PouchDB specifity
			await this.db.put({...latestDoc, endBlock: this.currentEvent.blockNumber - 1});
			console.info(`archive complete`);
		}
		console.info(`putting latest as removed...`);
		await this.db.put({
			_id: getID(id),
			removed: true,
			startBlock: this.currentEvent.blockNumber,
			endBlock: Number.MAX_SAFE_INTEGER,
			eventID: computeEventID(this.currentEvent),
		});
		console.info(`DONE`);
	}

	async queryAtBlock(query: Query & ({blockHash: string} | {blockNumber: number})): Promise<Result> {
		if (!this.finality) {
			throw new Error(`no finality setup`);
		}
		let blockNumber: number | undefined;
		if ('blockHash' in query) {
			const block = await this.db.get<BlockWithOnlyNumber>(`block_${query.blockHash}`);
			if (!block) {
				// TODO Error type for Result, or throw ?
				return {error: {code: 1111, message: `No Block with hash ${query.blockHash} found`}} as unknown as Result;

				// TODO query block number on provider, remove the need to store that value
			}
			blockNumber = block.number;
			delete query.blockHash;
		}
		if ('blockNumber' in query && query.blockNumber) {
			blockNumber = query.blockNumber;
			delete query.blockNumber;
		}

		if (!this.keepAllHistory) {
			const latestBlock = await this.db.get<Block>(`block`);
			if (!latestBlock) {
				return {error: {code: 1111, message: `No block`}} as unknown as Result;
			}
			if (!blockNumber || blockNumber < 0) {
				blockNumber = Math.max(0, latestBlock.number + (blockNumber ? blockNumber : 0));
			}
			if (blockNumber < latestBlock.number - this.finality) {
				// TODO Error type for Result, or throw ?
				return {error: {code: 1111, message: `Cannot go that far in the past`}} as unknown as Result;
			}
		} else if (!blockNumber || blockNumber < 0) {
			const latestBlock = await this.db.get<Block>(`block`);
			if (!latestBlock) {
				return {error: {code: 1111, message: `No block`}} as unknown as Result;
			}
			if (!blockNumber || blockNumber < 0) {
				blockNumber = Math.max(0, latestBlock.number + (blockNumber ? blockNumber : 0));
			}
			blockNumber = Math.max(0, latestBlock.number + blockNumber);
		}

		// const {docs: list} = await  this.db.query({
		//   selector: {
		//     ...query.selector,
		//     startBlock: {$lte: block.number}
		//   }
		// })

		// return {docs: list.filter(v => v.endBlock > block.number)};

		const {docs: list} = await this.db.query(query);
		return {
			docs: list.filter(
				(v) => (v.startBlock as number) <= (blockNumber as number) && (v.endBlock as number) >= (blockNumber as number)
			),
		};
		// return { docs: list };
	}
}
