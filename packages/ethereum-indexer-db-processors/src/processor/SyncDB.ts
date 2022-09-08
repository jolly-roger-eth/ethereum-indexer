import {
  DBObjectWithRev,
  getID,
  ID,
  JSONObject,
  FromDB,
  DBObject,
  PutAndGetDatabaseWithBatchSupport,
} from './Database';

import { logs } from 'named-logs';
import { EventWithId } from 'ethereum-indexer';

import { computeEventID } from './utils';
const namedLogger = logs('SyncDB');

export type SyncDB = {
  put(object: DBObject);
  get<T extends JSONObject>(id: ID): FromDB<T> | null;
  delete(id: ID);
};

// this is also a Revertable DB but without history support, even recent, hence it can only be used for final tx
export class BasicSyncDB implements SyncDB {
  protected localDB: { [id: string]: DBObject } = {};
  // TODO modifiedObjects and do not reset db
  protected deletedObjects: { [id: string]: DBObjectWithRev } = {};
  protected deletedIDs: { [id: string]: string } = {};
  protected currentEvent: EventWithId;

  constructor(protected db: PutAndGetDatabaseWithBatchSupport) {}

  prepareEvent(event: EventWithId) {
    this.currentEvent = event;
  }

  put(object: DBObject) {
    delete this.deletedObjects[object._id];
    delete this.deletedIDs[object._id];

    this.localDB[object._id] = {
      ...object,
      startBlock: this.currentEvent.blockNumber,
      endBlock: Number.MAX_SAFE_INTEGER,
      eventID: computeEventID(this.currentEvent),
    };
  }

  putAsIs(object: DBObject) {
    delete this.deletedObjects[object._id];
    delete this.deletedIDs[object._id];

    this.localDB[object._id] = object;
  }
  get<T extends JSONObject>(id: ID): FromDB<T> | null {
    return this.localDB[getID(id)] as FromDB<T>;
  }

  delete(id: ID) {
    // should we not follow convention as Revertable  like this :
    // await this.db.put({
    //   _id: getID(id),
    //   removed: true,
    //   startBlock: this.currentEvent.blockNumber,
    //   endBlock: Number.MAX_SAFE_INTEGER,
    //   eventID: computeEventID(this.currentEvent),
    // });

    const idAsString = getID(id);
    delete this.localDB[idAsString];
    if (typeof id === 'string') {
      if (!this.deletedObjects[idAsString]) {
        this.deletedIDs[idAsString] = id;
      }
    } else {
      if ('_rev' in id) {
        delete this.deletedIDs[idAsString];
        this.deletedObjects[idAsString] = id as DBObjectWithRev;
      } else {
        this.deletedIDs[idAsString] = idAsString;
      }
    }
  }

  async syncUp() {
    const deletedIDs: ID[] = Object.values(this.deletedIDs);
    const deletedObjects = Object.values(this.deletedObjects); // rev ?
    const objectsToPut = Object.values(this.localDB);
    const allToDelete = deletedIDs.concat(deletedObjects);

    namedLogger.info(`syncing up (${allToDelete.length} entities to delete, ${objectsToPut.length} to put})...`);

    namedLogger.info(`deleting: ${allToDelete}...`);
    await this.db.batchDelete(allToDelete);

    namedLogger.info(`updating/creating: ${JSON.stringify(objectsToPut)}...`);
    await this.db.batchPut(objectsToPut);

    namedLogger.info(`syncing up DONE)`);

    this.deletedObjects = {};
    this.deletedIDs = {};
    this.localDB = {}; // TODO if use modifiedObjects we could keep localDB as cache
  }

  async fetch(dependencies: (string | { id: string; nextID: (entity: any) => string })[]) {
    const idsToFetch: Set<string> = new Set();
    const furtherIDs: { id: string; nextID: (entity: any) => string }[] = [];
    for (const dependency of dependencies) {
      if (typeof dependency === 'string') {
        idsToFetch.add(dependency);
      } else {
        idsToFetch.add(dependency.id);
        furtherIDs.push(dependency);
      }
    }

    const entities = await this.db.batchGet(Array.from(idsToFetch));

    for (const entity of entities) {
      if (entity) {
        this.putAsIs(entity);
      }
    }

    const moreIdsToFetch: Set<string> = new Set();
    for (const furtherID of furtherIDs) {
      const entity = this.get(furtherID.id);
      const newID = furtherID.nextID(entity);
      if (newID) {
        moreIdsToFetch.add(newID);
      }
    }

    const moreEntities = await this.db.batchGet(Array.from(moreIdsToFetch));

    for (const entity of moreEntities) {
      if (entity) {
        this.putAsIs(entity);
      }
    }
  }
}
