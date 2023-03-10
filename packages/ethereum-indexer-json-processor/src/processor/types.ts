export type JSObject = {
	[key: string]: JSType;
};

export type JSType = string | number | boolean | bigint | JSType[] | JSObject;

import {
	AbiEvent,
	AbiParameterToPrimitiveType,
	AbiParametersToPrimitiveTypes,
	ExtractAbiEventNames,
	Abi,
	EventWithId,
	ExtractAbiEvent,
} from 'ethereum-indexer';

export type InputNames<T extends AbiEvent> = Extract<T['inputs'][number], {name: string}>['name'];
export type InputValues<T extends AbiEvent> = {
	[Property in InputNames<T>]: AbiParameterToPrimitiveType<Extract<T['inputs'][number], {name: Property}>>;
};

export type InputValueArray<T extends AbiEvent> = AbiParametersToPrimitiveTypes<T['inputs']>;

export type EventFunctions<ABI extends Abi, ProcessResultType extends JSObject> = {
	[Property in ExtractAbiEventNames<ABI> as `on${Property}`]?: (
		json: ProcessResultType,
		event: EventWithId<ABI> & {args: InputValues<ExtractAbiEvent<ABI, Property>>} //get event from ABU by name
	) => void;
};

export type MergedEventFunctions<
	T extends {[name: string]: {abi: Abi}},
	ProcessResultType extends JSObject
> = EventFunctions<MergedAbis<T>, ProcessResultType>;

export type MergedAbis<T extends {[name: string]: {abi: Abi}}> = [...T[keyof T]['abi']];
