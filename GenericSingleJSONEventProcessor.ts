import {Abi, EventWithId} from 'ethereum-indexer';
import {JSObject} from './types';
import {SingleEventJSONProcessor} from './EventProcessorOnJSON';

export abstract class GenericSingleEventJSONProcessor<
	T extends {[name: string]: {abi: Abi}},
	ProcessResultType extends JSObject
> implements SingleEventJSONProcessor<T, ProcessResultType>
{
	protected readonly: ProcessResultType;
	processEvent(json: ProcessResultType, event: EventWithId<ABI>): void {
		this.readonly = json;
		const functionName = `on${event.eventName}`;
		if (this[functionName]) {
			this[functionName](event);
		}
	}
}
