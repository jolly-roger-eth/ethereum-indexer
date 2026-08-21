import type {
	Abi,
	AbiParameterToPrimitiveType,
	ExtractAbiEvent,
	ExtractAbiEventNames,
	AbiEvent,
	LogEvent,
	LogEventWithParsingFailure,
} from 'ethereum-indexer';
import type {EntityDeclaration, EntityId} from '@ethereum-indexer/state-store-sqlite';

export type InputNames<T extends AbiEvent> = Extract<T['inputs'][number], {name: string}>['name'];
export type InputValues<T extends AbiEvent> = {
	[Property in InputNames<T>]: AbiParameterToPrimitiveType<Extract<T['inputs'][number], {name: Property}>>;
};

/**
 * The write surface a handler gets for ONE block.
 *
 * `get` is read-your-writes WITHIN the block being processed: it answers from the
 * mutations already staged for this block, and falls through to the store's
 * current state otherwise. That matters because a handler that increments a
 * counter must see the value an earlier event in the same block wrote, which is
 * the behaviour the in-memory path gets for free by mutating one object.
 *
 * Blocks below the one being processed are always already flushed, because a
 * block is applied before the next block's handlers run (see `applyBlock`: one
 * block is exactly one batch). So `get` never has to reason about more than the
 * current block.
 */
export type MutationContext = {
	/** The entity as it stands, including mutations staged earlier in this block. */
	get<T = Record<string, unknown>>(entity: string, id: EntityId): Promise<T | undefined>;
	/**
	 * Write the WHOLE row. Unlisted declared fields become NULL, mirroring the
	 * store's close-then-insert: a version is a complete row, not a delta. To
	 * change one field, `get` the record and spread it.
	 */
	set(entity: string, id: EntityId, values: Record<string, unknown>): void;
	/** Close the live version without opening a new one: absent from this block on, readable before it. */
	delete(entity: string, id: EntityId): void;
};

/** `on<EventName>` handlers, typed off the ABI exactly as the JS-object path types them. */
export type EventHandlers<ABI extends Abi, ProcessorConfig = undefined> = {
	[Property in ExtractAbiEventNames<ABI> as `on${Property}`]?: (
		state: MutationContext,
		event: LogEvent<ABI> & {args: InputValues<ExtractAbiEvent<ABI, Property>>},
		config: ProcessorConfig,
	) => Promise<void> | void;
};

/**
 * What an author writes: the entity schema, and a handler per event.
 *
 * The shape deliberately mirrors `JSProcessor` from the js-processor package, so
 * that moving a processor from an in-memory object to versioned rows is a change
 * of write calls and nothing else. `construct()` has no counterpart here: the
 * initial state of a versioned store is an empty set of tables, which `migrate`
 * creates from `entities`.
 */
export type SQLProcessor<ABI extends Abi, ProcessorConfig = undefined> = EventHandlers<ABI, ProcessorConfig> & {
	version?: string;
	/** `{name, id, fields}` per entity: the store owns the version columns, the DDL and the revert. */
	entities: readonly EntityDeclaration[];
	handleUnparsedEvent?(state: MutationContext, event: LogEventWithParsingFailure): void | Promise<void>;
};
