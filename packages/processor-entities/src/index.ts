export * from './types.js';
export * from './stream.js';
export * from './apply.js';

/**
 * Re-exported so a processor author imports the whole authoring surface from one
 * place. They are DEFINED in `@etherfold/state-store`, because they are what a
 * store must understand, not what a processor invents.
 */
export type {
	EntityDeclaration,
	EntityId,
	FieldType,
	MutationContext,
	Mutation,
	StateStore,
	StateStoreCapabilities,
	Retention,
} from '@etherfold/state-store';
