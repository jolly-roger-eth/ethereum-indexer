import {
	Abi,
	AbiEvent,
	AbiParametersToPrimitiveTypes,
	AbiParameterToPrimitiveType,
	ExtractAbiEvent,
	ExtractAbiEventNames,
} from 'abitype';
import {DecodeEventLogReturnType, encodeEventTopics} from 'viem';
import {EventWithId} from '../../dist';
import eip721 from './eip721';
import ERC721 from './eip721';
export type JSObject = {
	[key: string]: JSType;
};

export type JSType = string | number | boolean | bigint | JSType[] | JSObject;

export type InputNames<T extends AbiEvent> = Extract<T['inputs'][number], {name: string}>['name'];
export type InputValues<T extends AbiEvent> = {
	[Property in InputNames<T>]: AbiParameterToPrimitiveType<Extract<T['inputs'][number], {name: Property}>>;
};

export type InputValueArray<T extends AbiEvent> = AbiParametersToPrimitiveTypes<T['inputs']>;

export type EventFunctions<ABI extends Abi, ProcessResultType extends JSObject> = {
	[Property in ExtractAbiEventNames<ABI> as `on${Property}`]?: (
		json: ProcessResultType,
		event: {args: InputValues<ExtractAbiEvent<ABI, Property>>} //get event from ABU by name
	) => void;
};

export type MergedEventFunctions<
	T extends {[name: string]: {abi: Abi}},
	ProcessResultType extends JSObject
> = EventFunctions<MergedAbis<T>, ProcessResultType>;

export type MergedAbis<T extends {[name: string]: {abi: Abi}}> = [...T[keyof T]['abi']];

// const topics = encodeEventTopics({abi: ERC721, eventName: 'Transfer'});
// const parsed: DecodeEventLogReturnType<typeof ERC721, 'Transfer', typeof topics, '0x00000000000000000'> | null = null;
// parsed?.args?.to;

const func: EventFunctions<typeof eip721, JSObject> = {
	onTransfer(json, event) {
		event.args.to;
	},
};
