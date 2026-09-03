export * from './types.js';
export * from './errors.js';
export * from './indexer.js';
export * from './streamBuilder.js';
export * from './logFetcher.js';
export * from './ingestClient.js';
export * from './directIngestion.js';
export type {RetryPolicy} from './internal/utils/retry.js';
export * from './utils/index.js';
export type {ReorgCause, ReorgDetection} from './internal/engine/utils.js';
/**
 * The INVALIDATION VERDICT, published because a caller outside this package has
 * to act on it.
 *
 * `sourceInvalidationOf` answers, for a reconfigure, whether the stored data
 * still describes the source being run now -- separately for the raw log STREAM
 * and for the STATE folded out of it -- and names the block each half stopped
 * being valid FROM. That answer used to reach a log line and nothing else, so
 * every consumer got the one bit `ReconfigureOutcome.stateDiscarded` collapses
 * it into, and one bit cannot say which half died or from where.
 *
 * The TYPES are exported and the FUNCTION deliberately is not. The verdict is
 * REPORTED, on `ReconfigureOutcome`, for the same reason the discard is: a
 * caller re-deriving the rule from its own hashes gets a second, divergent
 * answer, and it fails in exactly the silent direction the report exists to
 * close.
 *
 * Do not confuse this with `streamDigestOf`. The verdict decides WHETHER
 * anything is invalid; the stream digest decides WHICH stream a result belongs
 * to. An entry appended above the cursor MOVES the digest and is still free, per
 * ADR-0034, so digest inequality is not a verdict and never stands in for one.
 */
export type {InvalidationReason, InvalidationVerdict, SourceInvalidation} from './internal/engine/utils.js';
/**
 * Exported because a HOST has to size things against the finality this stream
 * actually runs with, and there is exactly one implementation of that default
 * (see the function). A host that re-stated `finality` to configure, say, a
 * store's retention floor would be pinning a number that the wire identity is
 * hashed from, so it would keep working right up until the default moved and
 * then silently fork the config hash.
 */
export {resolveStreamConfig} from './internal/engine/utils.js';
export * from './generation/registry.js';
export * from './generation/memory.js';
/**
 * THE PROMOTION POLICY: when the canonical pointer moves on its own.
 *
 * Three values, and `on-catch-up` is the default in EVERY runtime -- there is
 * deliberately no per-runtime and no per-environment selection, because the axis
 * that would choose one is DEVELOPMENT versus PRODUCTION and nothing in a browser
 * build can detect it. Exported because a deployment SAYS which one it wants
 * (`IndexerOptions.promotion`), and because the resolved value is reported back
 * (`Indexer.promotion`) rather than each runtime keeping its own copy of the
 * default.
 */
export * from './generation/promotion.js';
/**
 * THE GENERATION CONTAINER, which is how an indexer is built.
 *
 * `Indexer` HOLDS generations and points at the one that answers reads;
 * `IndexerGeneration` (exported from `./indexer.js`) is ONE of them. See
 * `container.ts`.
 */
export * from './container.js';
export * from './stream/identity.js';
export * from './stream/fixture.js';
/**
 * THE READ-ONLY STREAM VIEW, which is what makes the one-writer rule structural.
 *
 * Read and write share ONE `ExistingStream`, so a generation handed the stream
 * to fold is handed the thing that also appends. `readOnlyStream` is how a
 * generation that merely READS a stream somebody else indexes is expressed at
 * all -- see `container.ts`'s `add`, which hands one to every follower.
 */
export * from './stream/readOnly.js';
export * from './stream/capture.js';
export * from './stream/segments.js';

export type {
	Abi,
	AbiConstructor,
	AbiError,
	AbiEvent,
	AbiFallback,
	AbiFunction,
	AbiInternalType,
	AbiItemType,
	AbiParameter,
	AbiParameterKind,
	AbiReceive,
	AbiStateMutability,
	AbiType,
	Address,
	SolidityAddress,
	SolidityArray,
	SolidityArrayWithTuple,
	SolidityArrayWithoutTuple,
	SolidityBool,
	SolidityBytes,
	SolidityFixedArrayRange,
	SolidityFixedArraySizeLookup,
	SolidityFunction,
	SolidityInt,
	SolidityString,
	SolidityTuple,
	TypedData,
	TypedDataDomain,
	TypedDataParameter,
	TypedDataType,
} from 'abitype';

export {Register, DefaultRegister, ResolvedRegister} from 'abitype';

export type {
	AbiParameterToPrimitiveType,
	AbiParametersToPrimitiveTypes,
	AbiTypeToPrimitiveType,
	BaseError,
	ExtractAbiError,
	ExtractAbiErrorNames,
	ExtractAbiErrors,
	ExtractAbiEvent,
	ExtractAbiEventNames,
	ExtractAbiEvents,
	ExtractAbiFunction,
	ExtractAbiFunctionNames,
	ExtractAbiFunctions,
	IsAbi,
	IsTypedData,
	Narrow,
	ParseAbi,
	ParseAbiItem,
	ParseAbiParameter,
	ParseAbiParameters,
	TypedDataToPrimitiveTypes,
} from 'abitype';
