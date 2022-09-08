import { ContractsInfo, EventProcessor, EventWithId, LastSync } from 'ethereum-indexer';
import fs from 'fs';
import path from 'path';
import { logs } from 'named-logs';
const console = logs('EventListFSStore');

function lexicographicNumber15(num: number): string {
  return num.toString().padStart(15, '0');
}

export class EventListFSStore implements EventProcessor {
  protected folder: string;
  constructor(folder: string) {
    this.folder = path.join(folder, 'logs');
    try {
      fs.mkdirSync(this.folder, { recursive: true });
    } catch (err) {}
  }

  async reset() {
    try {
      console.info(`EventListFSStore: reseting...`);
      fs.rmSync(this.folder, { recursive: true });
      fs.mkdirSync(this.folder, { recursive: true });
    } catch (err) {
      console.error(`failed to reset : ${err}`);
    }
  }

  async load(contractsData: ContractsInfo): Promise<LastSync> {
    // TODO check if contractsData matches old sync
    try {
      const content = fs.readFileSync(this.folder + `/lastSync.json`, 'utf8');
      const lastSync = JSON.parse(content);
      return lastSync;
    } catch (err) {
      return {
        lastToBlock: 0,
        latestBlock: 0,
        nextStreamID: 1,
        unconfirmedBlocks: [],
      };
    }
  }

  async process(eventStream: EventWithId[], lastSync: LastSync): Promise<void> {
    if (eventStream.length > 0) {
      const filename = `events_${lexicographicNumber15(eventStream[0].streamID)}_${lexicographicNumber15(
        eventStream[eventStream.length - 1].streamID,
      )}.json`;

      fs.writeFileSync(this.folder + `/${filename}`, JSON.stringify(eventStream, null, 2));
    }
    fs.writeFileSync(this.folder + `/lastSync.json`, JSON.stringify(lastSync));
    console.info(`EventListFSStore streamID: ${lastSync.nextStreamID}`);
  }
}
