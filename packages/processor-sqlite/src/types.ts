import type {Abi} from '@etherfold/core';
import type {EntityProcessor} from '@etherfold/processor-entities';

/**
 * The authoring API is NOT this package's.
 *
 * `MutationContext`, the `on<EventName>` handler map and the processor's
 * `version` describe how a processor is WRITTEN, not where its state ends up, so
 * they live in `@etherfold/processor-entities` and this package consumes them.
 * That is what makes one processor portable: the same object runs here, on a
 * server, and against any other `StateStore` in a browser, with no edit and no
 * second authoring surface to keep in step.
 *
 * They are re-exported so that an author who has picked SQLite can still import
 * everything from one place.
 */
export type {
	EntityProcessor,
	EventHandlers,
	InputNames,
	InputValues,
	MutationContext,
} from '@etherfold/processor-entities';

/**
 * What an author writes, when the state lives in versioned SQL rows.
 *
 * @deprecated Use `EntityProcessor` from `@etherfold/processor-entities`. The
 * type never had anything SQL in it: the name predates the seam being lifted out
 * of this package, and the alias is kept so existing processors compile
 * unchanged.
 */
export type SQLProcessor<ABI extends Abi, ProcessorConfig = undefined> = EntityProcessor<ABI, ProcessorConfig>;
