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
 * The old name for `EntityProcessor`, kept so existing processors compile
 * unchanged. The type never had anything SQL in it: the name predates the seam
 * being lifted out of this package.
 *
 * ## Do NOT rewrite this as `export type SQLProcessor<ABI, C> = EntityProcessor<ABI, C>`
 *
 * That looks equivalent and is not. `EntityProcessor` is an intersection whose
 * handler half is a mapped type with REMAPPED keys (`on${EventName}`), which
 * offers no site to infer `ABI` from. TypeScript still infers it, but only via
 * its shortcut for a source and target that share an alias SYMBOL. A re-export
 * specifier resolves to the very same symbol, so the shortcut fires; a
 * `type ... = ...` declaration creates a NEW symbol, the shortcut misses, and
 * `ABI` silently falls back to its `Abi` constraint. The visible damage is a
 * user writing `const p: SQLProcessor<typeof abi> = {...}` and then finding
 * `new VersionedStateEventProcessor(db, p)` rejected, with an error about the
 * handler map that names no cause. Pinned by `test/lifecycle.test.ts` and
 * `test/version.test.ts`, which annotate every processor with this alias.
 *
 * @deprecated Use `EntityProcessor` from `@etherfold/processor-entities`.
 */
export type {EntityProcessor as SQLProcessor} from '@etherfold/processor-entities';
