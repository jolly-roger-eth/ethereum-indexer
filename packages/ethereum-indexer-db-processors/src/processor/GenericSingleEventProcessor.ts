import {Abi, EventWithId} from 'ethereum-indexer';
import {PutAndGetDatabase} from './Database';
import {SingleEventProcessor} from './EventProcessorOnDatabase';

export abstract class GenericSingleEventProcessor<ABI extends Abi> implements SingleEventProcessor<ABI> {
	protected db: PutAndGetDatabase;
	async processEvent(db: PutAndGetDatabase, event: EventWithId<ABI>): Promise<void> {
		this.db = db;
		const functionName = `on${event.eventName}`;
		if (this[functionName]) {
			await this[functionName](event);
		}
	}
}
