import {logs} from 'named-logs';
import type {Statement} from './types.js';

const logger = logs('@etherfold/state-store-sqlite');

/**
 * Backends that are reached over the network cap how much one request may carry:
 * a number of statements, and a payload size. Those caps differ per backend and
 * per plan, so they are configuration here, never constants: this package
 * targets the `remote-sql` interface, and a hosted backend is one backend among
 * several rather than the thing being built for.
 */
export type BatchBounds = {
	/** Maximum statements in one `batch([...])`. */
	maxStatementsPerBatch: number;
	/** Approximate maximum payload of one `batch([...])`, in bytes. */
	maxBytesPerBatch: number;
};

/**
 * Deliberately conservative: small enough to fit inside the tightest hosted
 * limits we are aware of, so that the default never surprises anyone in
 * production. It is a throughput knob, not a correctness one: on a local file
 * database, raise both freely to pack more blocks per round-trip.
 */
export const DEFAULT_BATCH_BOUNDS: BatchBounds = {
	maxStatementsPerBatch: 100,
	maxBytesPerBatch: 90_000,
};

/** Rough payload cost of a statement: enough to stay under a size cap. */
export function estimateSize(statement: Statement): number {
	let size = statement.sql.length;
	for (const arg of statement.args) {
		if (typeof arg === 'string') size += arg.length;
		else if (arg instanceof Uint8Array) size += arg.byteLength;
		else if (arg === null || arg === undefined) size += 4;
		else size += 8;
	}
	return size;
}

/**
 * Pack groups of statements into batches, never splitting a group.
 *
 * A group is an INDIVISIBLE unit of atomicity: one block. Blocks are packed
 * together while they fit, because on a remote backend the cost is the
 * round-trip and not the SQLite work, and a batch stays one transaction however
 * many blocks it carries.
 *
 * A single group larger than the bound is emitted as one oversized batch rather
 * than being split. Splitting it would trade an atomicity guarantee, which is a
 * correctness property, for a throughput bound, which is a tuning parameter, and
 * would leave a half-applied block behind on failure. The backend may then
 * reject the request, which is a loud and recoverable failure, so it is logged
 * as a warning: the operator's fix is to raise the bound or to look at why one
 * block produced that many mutations.
 */
export function planBatches(
	groups: readonly (readonly Statement[])[],
	bounds: Partial<BatchBounds> = {},
): Statement[][] {
	const limits: BatchBounds = {...DEFAULT_BATCH_BOUNDS, ...bounds};
	const batches: Statement[][] = [];

	let current: Statement[] = [];
	let currentSize = 0;

	for (const group of groups) {
		if (group.length === 0) continue;
		const groupSize = group.reduce((total, statement) => total + estimateSize(statement), 0);

		if (group.length > limits.maxStatementsPerBatch || groupSize > limits.maxBytesPerBatch) {
			logger.warn(
				`a single atomic unit exceeds the configured batch bound ` +
					`(${group.length} statements, ~${groupSize} bytes, bound ${limits.maxStatementsPerBatch} statements / ` +
					`${limits.maxBytesPerBatch} bytes). Sending it as one batch anyway: splitting it would break atomicity. ` +
					`Raise the bound if the backend accepts more.`,
			);
		}

		const wouldOverflow =
			current.length > 0 &&
			(current.length + group.length > limits.maxStatementsPerBatch ||
				currentSize + groupSize > limits.maxBytesPerBatch);

		if (wouldOverflow) {
			batches.push(current);
			current = [];
			currentSize = 0;
		}

		current.push(...group);
		currentSize += groupSize;
	}

	if (current.length > 0) batches.push(current);
	return batches;
}
