export type JSONObject = {[x: string]: JSONValue};
export type JSONValue = string | number | boolean | JSONObject | JSONValue[] | Object[];

export type DBObject = FromDB<JSONObject>;

export type DBObjectWithRev = DBObject & {_rev: string};

export type FromDB<T extends JSONObject> = T & {_id: string; _rev?: string};

export type Query = {
	selector: JSONObject;
	sort?: string[];
	fields?: string[];
	blockNumber?: number;
	blockHash?: string;
};
export type Result = {docs: DBObject[]};

export type ID = string | {_id: string; _rev?: string};

export function getID(id: ID): string {
	return typeof id === 'string' ? id : id._id;
}
export interface PutAndGetDatabase {
	put(object: DBObject): Promise<void>;
	get<T extends JSONObject>(id: ID): Promise<FromDB<T> | null>;
	delete(id: ID): Promise<void>;
}

export interface PutAndGetDatabaseWithBatchSupport extends PutAndGetDatabase {
	batchGet<T extends JSONObject>(ids: ID[]): Promise<FromDB<T>[]>;
	batchPut(objects: DBObject[]): Promise<void>;
	batchDelete(ids: ID[]): Promise<void>;
}

export interface Database extends PutAndGetDatabaseWithBatchSupport {
	setup(config: {indexes: {fields: string[]}[]}): Promise<void>;
	reset(): Promise<Database>;
	query(query: Query): Promise<Result>;
}
