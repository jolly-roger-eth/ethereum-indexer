import {EventWithId} from 'ethereum-indexer';
import {JSObject} from './types';
import {SingleEventJSONProcessor} from './EventProcessorOnJSON';

export abstract class GenericSingleEventJSONProcessor<T extends JSObject> implements SingleEventJSONProcessor<T> {
	protected readonly: T;
	processEvent(json: T, event: EventWithId): void {
		this.readonly = json;
		const functionName = `on${event.name}`;
		if (this[functionName]) {
			this[functionName](event);
		}
	}
}
