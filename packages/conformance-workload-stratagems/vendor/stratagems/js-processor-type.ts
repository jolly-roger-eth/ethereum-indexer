/**
 * The `JSProcessor` type the vendored original was written against, VENDORED in
 * its turn.
 *
 * It lived in `@etherfold/js-processor`, the free-form authoring path, which is
 * deleted (ADR-0037). The processor beside this file is the ORACLE that computed
 * the committed golden states, and it is kept as the provenance of those bytes:
 * its handler bodies are the code that ran on Base. A vendored file cannot
 * survive with a dangling import, and re-pointing an import is exactly the class
 * of mechanical change `README.md` already records for it, so the type it names
 * is reproduced here instead.
 *
 * Nothing RUNS it any more -- there is no `fromJSProcessor` to drive it with, so
 * the golden states are a frozen expectation rather than a recomputable oracle
 * (`../../fixtures/README.md`). What this type buys is that the file still
 * TYPECHECKS, so a reader can see that the handlers below are the shape the
 * original was, rather than a folder of `any`.
 *
 * Copied from `@etherfold/js-processor`'s `processor/types.ts` and
 * `processor/utils.ts` as of the commit that deleted them.
 */
import type {
	Abi,
	AbiEvent,
	AbiParameterToPrimitiveType,
	ExtractAbiEvent,
	ExtractAbiEventNames,
	LogEvent,
	LogEventWithParsingFailure,
} from '@etherfold/core';

export type JSObject = {
	[key: string]: JSType;
};

export type JSType = string | number | boolean | bigint | JSType[] | JSObject;

type InputNames<T extends AbiEvent> = Extract<T['inputs'][number], {name: string}>['name'];

/** The named inputs of an event, as a UNION when `T` is one (the conditional makes it DISTRIBUTE). */
type InputValues<T extends AbiEvent> = T extends AbiEvent
	? {[Property in InputNames<T>]: AbiParameterToPrimitiveType<Extract<T['inputs'][number], {name: Property}>>}
	: never;

type EventFunctions<ABI extends Abi, ProcessResultType extends JSObject, ProcessorConfig = undefined> = {
	[Property in ExtractAbiEventNames<ABI> as `on${Property}`]?: ProcessorConfig extends undefined
		? (json: ProcessResultType, event: LogEvent<ABI> & {args: InputValues<ExtractAbiEvent<ABI, Property>>}) => void
		: (
				json: ProcessResultType,
				event: LogEvent<ABI> & {args: InputValues<ExtractAbiEvent<ABI, Property>>},
				config: ProcessorConfig,
			) => Promise<void> | void;
};

export type JSProcessor<
	ABI extends Abi,
	ProcessResultType extends JSObject,
	ProcessorConfig = undefined,
> = EventFunctions<ABI, ProcessResultType, ProcessorConfig> & {
	/** The identity of this processor's logic. */
	version: string;
	construct(): ProcessResultType;
	handleUnparsedEvent?(json: ProcessResultType, event: LogEventWithParsingFailure): void | Promise<void>;
};
