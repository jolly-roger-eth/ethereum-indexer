import {DBObjectWithRev, getID, ID, Database, DBObject, FromDB, JSONObject, JSONValue, Result} from './Database';

import PouchDB from 'pouchdb';
import PouchDBFindPlugin from 'pouchdb-find';
PouchDB.plugin(PouchDBFindPlugin);

import {logs} from 'named-logs';
const console = logs('PouchDatabase');

export class PouchDatabase implements Database {
	private pouchDB: PouchDB.Database;
	constructor(private path: string) {
		this.pouchDB = new PouchDB(`${this.path}`, {revs_limit: 0});
	}

	async setup(config: {indexes: {fields: string[]}[]}): Promise<void> {
		for (const index of config.indexes) {
			this.pouchDB.createIndex({
				index,
			});
		}
	}

	async reset(): Promise<Database> {
		this.pouchDB = new PouchDB(`${this.path}`, {revs_limit: 0});
		return this;
	}

	async put(object: DBObject): Promise<void> {
		if (object._rev) {
			await this.pouchDB.put(object);
		} else {
			await this.pouchDB
				.get(object._id)
				.then((d) => {
					console.info(`PouchDatabase: got object before put`);
					(object as any)._rev = d._rev;
					return this.pouchDB.put(object).then((v) => {
						console.info(`PouchDatabase: put DONE`);
						return v;
					});
				})
				.catch((e) => {
					return this.pouchDB.put(object);
				});
		}
	}
	async get<T extends JSONObject>(id: ID): Promise<FromDB<T> | null> {
		let result: T | null;
		try {
			result = await this.pouchDB.get(getID(id));
		} catch (e) {
			result = null;
		}
		return result as FromDB<T>;
	}

	async batchGet<T extends JSONObject>(ids: string[]): Promise<FromDB<T>[]> {
		const {rows} = await this.pouchDB.allDocs({keys: ids, include_docs: true});
		return rows.filter((v) => !v.value?.deleted).map((v) => v.doc) as unknown as FromDB<T>[];
	}
	async batchPut(objects: FromDB<JSONObject>[]): Promise<void> {
		const response = await this.pouchDB.bulkDocs(objects);
		console.info(JSON.stringify(response, null, 2));
	}
	async batchDelete(ids: ID[]): Promise<void> {
		const objects: FromDB<JSONObject>[] = [];
		const idsOfObjectMissing: string[] = [];
		for (const id of ids) {
			if (typeof id === 'string') {
				idsOfObjectMissing.push(id);
			} else {
				objects.push(id);
			}
		}

		const objectsMissing = await this.batchGet(idsOfObjectMissing);

		const deletions = objects.concat(objectsMissing).map((v: DBObjectWithRev) => ({
			_deleted: true,
			_id: v._id,
			_rev: v._rev,
		}));
		await this.pouchDB.bulkDocs(deletions);
	}

	async delete(id: ID) {
		if (typeof id === 'string') {
			await this.pouchDB.get(id).then((d) => {
				return this.pouchDB.remove(d);
			});
		} else {
			if ('_rev' in id) {
				await this.pouchDB.remove(id as DBObjectWithRev);
			} else {
				await this.pouchDB.get(getID(id)).then((d) => {
					return this.pouchDB.remove(d);
				});
			}
		}
	}

	async query(query: {selector: JSONObject; sort?: string[]; fields?: string[]}): Promise<Result> {
		return this.pouchDB.find(query) as unknown as Result;
	}
}
