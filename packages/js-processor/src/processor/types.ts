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
	LogEvent,
	ExtractAbiEvent,
} from '@etherfold/core';

export type InputNames<T extends AbiEvent> = Extract<T['inputs'][number], {name: string}>['name'];

/**
 * The named inputs of an event, as a UNION when `T` is one.
 *
 * The conditional is not decoration: it makes the mapped type DISTRIBUTE. An
 * upgraded contract can carry two events under one name
 * (`Transfer(address,address,uint256)` then
 * `Transfer(address,address,uint256,bytes)`), and `ExtractAbiEvent` hands both
 * of them over as a union, because a handler is keyed by NAME. Mapped without
 * distributing, the two input lists MERGED into `{from, to, id, memo}` with
 * `memo` REQUIRED -- so a pre-upgrade log handed the author `undefined` through
 * a type promising a value. Distributed, `args` is a union the author narrows
 * (`'memo' in event.args`) before reading a field only one version has.
 *
 * The single-version case is unchanged: distributing over a non-union is the
 * mapped type itself. Pinned both ways in `test/handlerArgs.test.ts`, under
 * `pnpm typecheck`.
 */
export type InputValues<T extends AbiEvent> = T extends AbiEvent
	? {[Property in InputNames<T>]: AbiParameterToPrimitiveType<Extract<T['inputs'][number], {name: Property}>>}
	: never;

export type InputValueArray<T extends AbiEvent> = AbiParametersToPrimitiveTypes<T['inputs']>;

export type EventFunctions<ABI extends Abi, ProcessResultType extends JSObject, ProcessorConfig = undefined> = {
	[Property in ExtractAbiEventNames<ABI> as `on${Property}`]?: ProcessorConfig extends undefined
		? (json: ProcessResultType, event: LogEvent<ABI> & {args: InputValues<ExtractAbiEvent<ABI, Property>>}) => void
		: (
				json: ProcessResultType,
				event: LogEvent<ABI> & {args: InputValues<ExtractAbiEvent<ABI, Property>>},
				config: ProcessorConfig,
			) => Promise<void> | void;
};

export type MergedEventFunctions<
	T extends {[name: string]: {abi: Abi}},
	ProcessResultType extends JSObject,
	ProcessorConfig = undefined,
> = EventFunctions<MergedAbis<T>, ProcessResultType, ProcessorConfig>;

export type MergedAbis<T extends {[name: string]: {abi: Abi}}> = [...T[keyof T]['abi']];
