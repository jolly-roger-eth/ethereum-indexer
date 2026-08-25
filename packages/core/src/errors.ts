import type {WireContext} from './types.js';

/**
 * A batch that did not start where the receiver said it must.
 *
 * ## Why this is a TYPE and not a message
 *
 * ADR-0004 makes the receiver authoritative about the cursor, and the whole
 * resumption protocol is this one refusal: the sender is told the block it must
 * re-send from, and it re-sends from there. A caller that has to read
 * `expectedFromBlock` out of an English sentence is a caller that breaks the
 * next time the sentence is reworded, and an HTTP layer on top has to put that
 * number in a response body. So the number is carried, not narrated.
 *
 * It is thrown by `generateStreamToAppend` itself rather than by a check placed
 * in front of it. That matters: a second check would be a second, parallel
 * mechanism that can disagree with the engine, which is exactly what ADR-0004
 * chose this design to avoid. There is one rule, in one function, and this is
 * the shape it refuses in.
 *
 * ## And why it is not an idempotency failure
 *
 * A re-sent batch after a lost acknowledgement lands here, because the cursor
 * has already moved past its `fromBlock`. That is not an error to paper over:
 * it IS the deduplication. At-least-once on the wire becomes exactly-once in
 * effect, with no dedupe table and no explicit key, because the cursor is the
 * key.
 */
export class UnexpectedFromBlockError extends Error {
	readonly name = 'UnexpectedFromBlockError';

	constructor(
		/** Where the next batch must start. The sender re-sends from here. */
		readonly expectedFromBlock: number,
		/** Where this batch actually started. */
		readonly receivedFromBlock: number,
	) {
		super(
			`fromBlock (${receivedFromBlock}) not as expected (${expectedFromBlock}). ` +
				(receivedFromBlock > expectedFromBlock
					? `This is too far back, we could trim it automatically, but this is probably an error to send that, so we throw here`
					: `The fromBlock do not consider the potential of reorg, the only safe fromBlock is ${expectedFromBlock}`),
		);
	}
}

/**
 * A batch that belongs to a different indexer.
 *
 * `context.source` and `context.config` are asserted by the SENDER and checked
 * on every batch, because the alternative is silently corrupted state: logs for
 * one source folded into the state of another, discovered later as a wrong
 * answer with nothing pointing at the cause. It is the wire-side half of the
 * hole `docs/reviews/todo-triage.md` found in every persistence layer.
 *
 * Deliberately NOT an `UnexpectedFromBlockError`, and the distinction is
 * operational rather than cosmetic. A cursor refusal is RECOVERABLE by the
 * sender on its own: re-send from the block named. A context mismatch is a
 * misconfiguration, and no block number makes it right; a sender that treated
 * the two alike would retry forever against a server that will never accept it.
 *
 * `context.processor` is absent from what is checked here, because the sender
 * cannot assert it: it has no idea which processor version runs on this side.
 * The receiver owns that third identity and checks it against its own persisted
 * cursor instead (see `StreamBuilder`).
 */
export class WireContextMismatchError extends Error {
	readonly name = 'WireContextMismatchError';

	constructor(
		/** The `{source, config}` this receiver indexes. */
		readonly expected: WireContext,
		/** The `{source, config}` the batch claimed. */
		readonly received: WireContext,
	) {
		super(
			`this batch is for another {source, config}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(
				received,
			)}`,
		);
	}
}

/**
 * A batch whose envelope does not describe a contiguous, complete block range.
 *
 * The three things it catches are the three ways the wire contract can be broken
 * without lying about identity or position:
 *
 * - a range that is not a range (`toBlock < fromBlock`, a non-integer bound, a
 *   `toBlock` above the `latestBlock` the sender itself reported);
 * - a log outside `[fromBlock, toBlock]`, which means the payload is not the
 *   range it claims. **Completeness is an invariant, not a flag**: a payload
 *   holds every log in its range, and a truncated fetch is expressed by LOWERING
 *   `toBlock`, never by delivering a different set. A `complete: true` field
 *   would always be true and would therefore carry no information;
 * - a log already carrying `removed: true`. No reorg information crosses the
 *   wire (ADR-0004): the receiver derives retractions, so a sender that shipped
 *   them has reorg logic it must not have. Silently dropping them would be
 *   worse than refusing, since `groupLogsPerBlock` skips them and the sender
 *   would never learn its markers went nowhere.
 */
export class InvalidBatchError extends Error {
	readonly name = 'InvalidBatchError';

	constructor(message: string) {
		super(message);
	}
}
