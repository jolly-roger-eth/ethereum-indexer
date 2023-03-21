import {Abi, LogEvent} from 'ethereum-indexer';
import {PutAndGetDatabase} from 'ethereum-indexer-db-utils';
import {SingleEventProcessor} from './EventProcessorOnDatabase';

export abstract class GenericSingleEventProcessor<ABI extends Abi> implements SingleEventProcessor<ABI> {
	protected db: PutAndGetDatabase | undefined;
	async processEvent(db: PutAndGetDatabase, event: LogEvent<ABI>): Promise<void> {
		this.db = db;
		if ('decodeError' in event) {
			if ('handleUnparsedEvent' in this && (this as any).handleUnparsedEvent) {
				return (this as any).handleUnparsedEvent(event);
			}
			return;
		}

		const functionName = `on${event.eventName}`;
		if ((this as any)[functionName]) {
			await (this as any)[functionName](event);
		}
	}
	abstract getVersionHash(): string;
}
