import {EventWithId} from 'ethereum-indexer';
import {JSObject} from './types';
import {SingleEventJSONProcessor} from './EventProcessorOnJSON';

export abstract class GenericSingleEventJSONProcessor<T extends JSObject> implements SingleEventJSONProcessor<T> {
	protected json: T;
	processEvent(json: T, event: EventWithId): void {
		this.json = json;
		const functionName = `on${event.name}`;
		if (this[functionName]) {
			this[functionName](event);
		}
	}
}
