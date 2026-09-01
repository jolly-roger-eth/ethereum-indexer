import type {Abi} from 'abitype';
import type {LastSync} from './types.js';

/**
 * ## The BLOB snapshot envelope, and why its version number lives HERE
 *
 * A `KeepState` keeper on the free-form path persists the whole state as ONE
 * blob. `@etherfold/cli`'s file keeper writes that blob into an envelope --
 * `{format, processor, savedAt, lastSync, state, history}` -- and publishes it,
 * and `keepStateOnIndexedDB(name, remote)` in `@etherfold/browser` downloads it
 * to hydrate a tab instead of replaying every log the contract ever emitted.
 *
 * So the file has ONE writer and TWO readers, in three packages. The number that
 * says which encoding the bytes are in used to live with the writer
 * (`@etherfold/cli`), where the browser could not see it: the CLI refused a
 * format-1 file locally and the browser installed the very same bytes, whose
 * every `uint256` had by then become the STRING `"123n"` (ADR-0029 removed the
 * suffix reviver, correctly, and no reader translates). Putting the number in
 * `@etherfold/core` is what makes the check possible at all on the reading side:
 * both packages already depend on core, core is browser-bundleable (which
 * `@etherfold/cli` is not, and which `bundlesForABrowser.test.ts` pins), and the
 * CODEC the number versions (`taggedBnReplacer` / `taggedBnReviver`) is already
 * here. A second constant in the browser kept in step with the CLI's by
 * attention is the outcome this placement exists to avoid.
 *
 * ## Why the name is not `SNAPSHOT_FORMAT`
 *
 * Two unrelated artifacts are called a snapshot in this repo and both carry a
 * format number: this blob envelope, and the ENTITY snapshot at the storage seam
 * (`ENTITY_SNAPSHOT_FORMAT`, `@etherfold/state-store`, refused with
 * `SnapshotFormatError`). They version different file SHAPES and revise
 * independently, so they must not be merged -- and `@etherfold/browser` depends
 * on both, so a call site can hold the two at once and a bare `SNAPSHOT_FORMAT`
 * there would be a coin toss. One constant per envelope, each named after its
 * envelope.
 *
 * ## Why it is 2
 *
 * Format 1 (and the bare pre-envelope form, which reads as `format ===
 * undefined`) encoded a BigInt by suffixing its decimal form with `n`, which is
 * also a perfectly legal string for a contract to emit, so its reader had to
 * guess. Format 2 TAGS them instead. A format-1 file is therefore not
 * translated, it is REFUSED: the translation IS the guess (ADR-0029), and the
 * recovery for a snapshot that cannot be read -- on both readers -- is to index
 * without it.
 */
export const BLOB_SNAPSHOT_FORMAT = 2;

/**
 * The published/persisted envelope around one blob of state.
 *
 * `processor` and `savedAt` are PROVENANCE: nothing keys off them here, because
 * the state a keeper hands back is checked against the running processor's
 * version hash by the indexer itself (`EthereumIndexer.load` compares
 * `lastSync.context.processor`), so a keeper that also refused on it would be
 * making the same decision twice, in the place with less information.
 */
export type BlobSnapshotEnvelope<ABI extends Abi, ProcessResultType, Extra = unknown> = {
	format: number;
	/** The version hash of the processor that computed `state`. Provenance only; see above. */
	processor?: string;
	/** ISO-8601, when the snapshot was written. Informational. */
	savedAt?: string;
	lastSync: LastSync<ABI>;
	state: ProcessResultType;
} & Extra;

/**
 * Whether these bytes are an envelope THIS build can read.
 *
 * Shallow on purpose, exactly as `parseStreamFixture` is shallow: it answers
 * "was this written by a build that agrees with me about the encoding", which is
 * the question a wrong answer to is silent. A file that passes and is then
 * malformed in some other way fails loudly wherever it is used, which is an
 * ordinary bug; a file that fails HERE is refused as a whole rather than mined
 * for the fields that happen to be recognisable, because state understood in
 * part is state a caller cannot tell apart from state understood fully.
 *
 * `lastSync` is required because a snapshot's cursor is not optional
 * decoration: it is what says which blocks the state accounts for, and every
 * reader compares it (against a local state's cursor, against another mirror's)
 * before doing anything with the state.
 */
export function isReadableBlobSnapshot<ABI extends Abi, ProcessResultType>(
	value: unknown,
): value is BlobSnapshotEnvelope<ABI, ProcessResultType> {
	if (!value || typeof value !== 'object') return false;
	const envelope = value as Partial<BlobSnapshotEnvelope<Abi, unknown>>;
	if (envelope.format !== BLOB_SNAPSHOT_FORMAT) return false;
	return !!envelope.lastSync && typeof envelope.lastSync === 'object';
}
