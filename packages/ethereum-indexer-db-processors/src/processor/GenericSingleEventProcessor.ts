import {EventWithId} from 'ethereum-indexer';
import {PutAndGetDatabase} from './Database';
import {SingleEventProcessor} from './EventProcessorOnDatabase';

export abstract class GenericSingleEventProcessor implements SingleEventProcessor {
	protected db: PutAndGetDatabase;
	async processEvent(db: PutAndGetDatabase, event: EventWithId): Promise<void> {
		this.db = db;
		const functionName = `on${event.name}`;
		if (this[functionName]) {
			await this[functionName](event);
		}
	}
}
