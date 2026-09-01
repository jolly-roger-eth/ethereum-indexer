import {logs} from 'named-logs';
import type {Statement} from './types.js';

const logger = logs('@etherfold/state-store-sqlite');

/**
 * Backends that are reached over the network cap how much one request may carry:
 * a number of statements, a payload size, and how much one statement may touch.
 * Those caps differ per backend and per plan, so they are configuration here,
 * never constants: this package targets the `remote-sql` interface, and a hosted
 * backend is one backend among several rather than the thing being built for.
 */
export type BatchBounds = {
	/** Maximum statements in one `batch([...])`. */
	maxStatementsPerBatch: number;
	/** Approximate maximum payload of one `batch([...])`, in bytes. */
	maxBytesPerBatch: number;
	/**
	 * Maximum rows ONE statement may name, which is what keeps `prune` runnable.
	 *
	 * The other two bounds are about a batch and say nothing about a single
	 * statement that touches an unbounded number of rows: `DELETE FROM t WHERE
	 * _upper <= ?` is one statement of eighty bytes that can delete a hundred
	 * thousand rows, and a hosted backend caps rows written and wall-clock per
	 * request, so that statement is exactly the shape that runs locally and is
	 * rejected in production. A prune therefore deletes by an explicit, bounded
	 * list of row ids, and this is the bound.
	 *
	 * It is also a bound on BOUND PARAMETERS, since each row id is one, so it must
	 * stay under the tightest per-query variable limit of any backend it may run
	 * against. A stock SQLite build allows 999; the tightest hosted backend allows
	 * only 100, which is what the default is set by. See `DEFAULT_BATCH_BOUNDS`.
	 *
	 * `dropVersionsStatement` is the only statement whose parameter count scales
	 * with this bound, and it carries NO other bound parameter, so the default may
	 * sit exactly on the cap. If a parameter is ever added to that statement, this
	 * default must drop by the same amount -- `batch.test.ts` guards the coupling.
	 */
	maxRowsPerStatement: number;
};

/**
 * The default targets the TIGHTEST documented limits, on the FREE tier, of any
 * hosted backend this store is expected to run behind, so that a deployment that
 * configures nothing works everywhere. It is mostly a throughput knob: on a local
 * file database, or on a paid tier, raise all three freely to pack more blocks
 * per round-trip.
 *
 * **`maxRowsPerStatement` is the exception -- there it is a CORRECTNESS bound.**
 * The tightest hosted backend caps bound parameters per query at 100, and a
 * previous default of 500 made `prune` emit a query it rejects, so retention
 * enforcement failed on that backend while passing on every other one. That is
 * the shape that runs locally and fails only in production, which is why the
 * default is now set by the tightest backend rather than by the most permissive.
 *
 * `maxStatementsPerBatch` of 50 comes from a per-INVOCATION query budget on the
 * same backend's free tier. Two honest caveats, stated rather than papered over:
 * that budget is per invocation and not per batch, and its documentation does not
 * settle whether one `batch()` of N statements counts as N queries or as one
 * subrequest, so 50 is the pessimistic reading under which a single batch is
 * issuable either way. What NO batch bound can fix is one invocation issuing
 * several batches plus its surrounding reads: keeping a request inside a
 * per-invocation budget is the HOST's job, and `prune`'s explicit budget
 * parameter is the lever that exists for it.
 *
 * `maxBytesPerBatch` is unchanged and is NOT what satisfies any per-STATEMENT
 * size cap: those are different quantities that happen not to collide.
 *
 * **Where the vendor's numbers actually live: `work/notes/findings/`, and
 * deliberately not here.** This package targets the `remote-sql` interface, so a
 * hosted backend is one backend among several and never the target;
 * `test/no-platform-leakage.test.ts` asserts that no source file in this package
 * names one. The findings note (grep for "bound parameters per query") carries the
 * vendor, the exact limits, the dated source and the plan split; a host adapter is
 * the only place allowed to name its own backend and pass `{bounds}` accordingly.
 */
export const DEFAULT_BATCH_BOUNDS: BatchBounds = {
	maxStatementsPerBatch: 50,
	maxBytesPerBatch: 90_000,
	maxRowsPerStatement: 100,
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
