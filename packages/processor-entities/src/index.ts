export * from './types.js';
export * from './stream.js';
export * from './apply.js';
export * from './cursor.js';
export * from './view.js';
export * from './EntityEventProcessor.js';

/**
 * Re-exported so a processor author imports the whole authoring surface from one
 * place. They are DEFINED in `@etherfold/state-store`, because they are what a
 * store must understand, not what a processor invents.
 */
export type {
	CursorWrite,
	EntityDeclaration,
	EntityId,
	FieldType,
	MutationContext,
	Mutation,
	PruneOptions,
	PruneReport,
	StateStore,
	StateStoreCapabilities,
	Retention,
	RetentionSetting,
} from '@etherfold/state-store';

/**
 * The READ half of the same declarations, re-exported for the same reason.
 *
 * `declareEntities` keeps a declaration's literal types, so the ONE array an
 * author writes is both what `entities` declares to the store and what
 * `createReadSurface` types a consumer's reads off. Defined in
 * `@etherfold/state-store` because it derives from the declaration, which is the
 * store's vocabulary rather than the processor's.
 */
export {createReadSurface, declareEntities} from '@etherfold/state-store';
export type {
	AsOfAddress,
	EntityIdOf,
	EntityPrefixOf,
	EntityReads,
	EntityRow,
	FieldValue,
	ReadSurface,
} from '@etherfold/state-store';
