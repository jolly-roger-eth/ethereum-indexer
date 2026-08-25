import {
	InvalidBatchError,
	UnexpectedFromBlockError,
	WireContextMismatchError,
	parseWireBatch,
	type LogIngestion,
	type UntypedWireBatch,
} from '@etherfold/core';
import {Hono} from 'hono';
import type {Context} from 'hono';
import {logs} from 'named-logs';
import type {Env} from '../env.js';
import {recordReorg} from '../reorgs.js';
import {setup} from '../setup.js';
import type {ServerOptions} from '../types.js';

const logger = logs('@etherfold/server');

/**
 * Compare two secrets without leaking WHERE they first differ.
 *
 * Written out rather than taken from `node:crypto`, because this package names
 * no runtime (a test asserts it). It leaks the LENGTH, which the archived
 * server's `timingSafeEqual` version also did, and which tells an attacker
 * nothing they cannot get by counting characters in a rejected guess.
 */
function secretEquals(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let difference = 0;
	for (let i = 0; i < a.length; i++) {
		difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return difference === 0;
}

/**
 * Whether this caller may touch the cursor.
 *
 * Fail-closed on a missing `INGEST_TOKEN`: a server that can authenticate nobody
 * authenticates nobody. The message names the variable, because the alternative
 * is an operator staring at a 401 they configured themselves.
 */
function authorized(c: Context<{Bindings: Env}>): {ok: true} | {ok: false; message: string} {
	const configured = c.get('config')?.env?.INGEST_TOKEN;
	if (!configured) {
		logger.error(`/ingest called with no INGEST_TOKEN configured: refusing every caller`);
		return {ok: false, message: `no INGEST_TOKEN is configured on this server, so no caller can be authenticated`};
	}
	const header = c.req.header('Authorization');
	const presented = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
	if (!presented || !secretEquals(configured, presented)) {
		return {ok: false, message: `expected an Authorization: Bearer <token> header matching INGEST_TOKEN`};
	}
	return {ok: true};
}

/**
 * The log ingestion endpoint: where raw logs enter the server, and the half of
 * the wire contract that makes losing an event structurally difficult.
 *
 * ## What this layer decides, and what it only reports
 *
 * Every RULE lives in the stream-builder (`@etherfold/core`), which is where the
 * engine's own cursor check already lives. This route decides three things a
 * transport has to decide and the engine cannot:
 *
 * - **who may call it.** A caller with no token cannot advance the cursor.
 * - **which status code each refusal is.** `409` is the one and only RESUMABLE
 *   refusal: it carries `expectedFromBlock`, and a sender's whole recovery is to
 *   re-send from there. `400` is a sender that is wrong in a way no block number
 *   fixes (a foreign `{source, config}`, a malformed range, a payload that is
 *   not the range it claims). Collapsing the two would make a misconfigured
 *   fetcher retry forever against a server that will never accept it.
 * - **what an operator can watch.** A revert concluded from ABSENCE is counted
 *   apart from one concluded from a hash CONTRADICTION, because absence is an
 *   inference and a rising rate of it means truncation or misconfiguration
 *   rather than chain activity (ADR-0004).
 *
 * ## What is deliberately absent
 *
 * No idempotency key and no dedupe table: the cursor IS the key. A re-sent batch
 * after a lost acknowledgement fails the `expectedFromBlock` check and is
 * corrected, so it cannot be applied twice.
 */
export function getIngestAPI<CustomEnv extends Env>(options: ServerOptions<CustomEnv>) {
	return (
		new Hono<{Bindings: CustomEnv}>()
			.use(setup({serverOptions: options}))
			/**
			 * The token guard, on the PATH rather than inside each handler.
			 *
			 * "The endpoint requires authentication" is then a property of `/ingest`
			 * itself: a route added here later inherits it instead of needing somebody
			 * to remember. It covers the read as well as the write, because this whole
			 * surface is the fetcher's private API, and one rule for all of it is one
			 * rule to get wrong.
			 *
			 * BOTH patterns are registered on purpose. Hono matches `/ingest` exactly,
			 * so it does NOT cover `/ingest/expected-from-block`, and the wildcard alone
			 * does not cover the bare path. Registering one of the two would leave half
			 * this surface open while looking guarded -- which is the failure mode the
			 * path-level guard exists to remove. `test/ingest.test.ts` asserts a 401 on
			 * each of them.
			 */
			.use('/ingest', async (c, next) => {
				const auth = authorized(c as never);
				if (!auth.ok) {
					return c.json({success: false, error: 'unauthorized', message: auth.message} as const, 401);
				}
				return next();
			})
			.use('/ingest/*', async (c, next) => {
				const auth = authorized(c as never);
				if (!auth.ok) {
					return c.json({success: false, error: 'unauthorized', message: auth.message} as const, 401);
				}
				return next();
			})
			/**
			 * Where the next batch must start.
			 *
			 * A stateless log-fetcher holds no cursor, so before its FIRST fetch it has
			 * nothing to be corrected from and must ask.
			 *
			 * ## Why this is a POST for a question
			 *
			 * Answering it can WRITE. Reading the cursor reconciles one belonging to a
			 * different source, config or processor version by calling
			 * `processor.clear()`, exactly as `load()` does in the single-process shape --
			 * the alternative being to answer from state the next batch is about to wipe,
			 * so the read and the write disagree.
			 *
			 * A `GET` that writes is a trap whatever its justification: proxies, browser
			 * prefetch, link scanners and retry-happy clients all assume a `GET` is safe,
			 * and HTTP says it is. Rather than keep the side effect and document it, the
			 * method matches what it does. The cost is one un-RESTful-looking POST for a
			 * question; the alternative was an endpoint whose safety depended on nobody
			 * ever pointing a crawler at it.
			 */
			.post('/ingest/expected-from-block', async (c) => {
				const ingestion = options.getIngestion?.(c as never);
				if (!ingestion) return notConfigured(c as never);

				return c.json({
					success: true,
					expectedFromBlock: await ingestion.expectedFromBlock(),
					context: ingestion.context,
				} as const);
			})
			.post('/ingest', async (c) => {
				const ingestion = options.getIngestion?.(c as never);
				if (!ingestion) return notConfigured(c as never);

				let batch: UntypedWireBatch;
				try {
					// parsed with the wire codec rather than `c.req.json()`: a decoded log's
					// `args` carry a BigInt for every uint256 an ABI declares, and plain JSON
					// has no way to say so
					batch = parseWireBatch(await c.req.text());
				} catch (err) {
					return c.json(
						{
							success: false,
							error: 'invalid-json',
							message: err instanceof Error ? err.message : String(err),
						} as const,
						400,
					);
				}

				try {
					const outcome = await ingestion.receive(batch);

					if (outcome.reorg) {
						await recordReorgSafely(c as never, ingestion, outcome.reorg);
					}

					return c.json({
						success: true,
						fromBlock: batch.fromBlock,
						toBlock: batch.toBlock,
						latestBlock: batch.latestBlock,
						applied: outcome.applied,
						retracted: outcome.retracted,
						// handed back so an acknowledged sender needs no second round-trip
						expectedFromBlock: outcome.expectedFromBlock,
						reorg: outcome.reorg,
					} as const);
				} catch (err) {
					return refusal(c as never, err);
				}
			})
	);
}

function notConfigured(c: Context<{Bindings: Env}>) {
	return c.json(
		{
			success: false,
			error: 'ingestion-not-configured',
			message: `this server hosts no processor: pass getIngestion to createServer to accept logs`,
		} as const,
		501,
	);
}

/**
 * Map a refusal onto the status code a sender steers by.
 *
 * Anything not recognised is re-thrown to the app's error handler, which is a
 * `500`. That is the honest answer for an unexpected failure: a sender must not
 * read "the database is down" as "re-send from block N".
 */
function refusal(c: Context<{Bindings: Env}>, err: unknown) {
	if (err instanceof UnexpectedFromBlockError) {
		logger.info(
			`ingest: refusing a batch at ${err.receivedFromBlock}, expecting ${err.expectedFromBlock}: the sender will re-send`,
		);
		return c.json(
			{
				success: false,
				error: 'unexpected-fromBlock',
				expectedFromBlock: err.expectedFromBlock,
				receivedFromBlock: err.receivedFromBlock,
				message: err.message,
			} as const,
			409,
		);
	}
	if (err instanceof WireContextMismatchError) {
		logger.error(`ingest: a batch arrived for another {source, config}: ${err.message}`);
		return c.json(
			{
				success: false,
				error: 'context-mismatch',
				expected: err.expected,
				received: err.received,
				message: err.message,
			} as const,
			400,
		);
	}
	if (err instanceof InvalidBatchError) {
		logger.error(`ingest: a malformed batch was refused: ${err.message}`);
		return c.json({success: false, error: 'invalid-batch', message: err.message} as const, 400);
	}
	throw err;
}

/**
 * Count the revert, without letting the counter fail the request that earned it.
 *
 * The state and the cursor already moved atomically inside the processor. If
 * writing an operational counter afterwards fails, the correct outcome is a
 * logged miscount and a successful ingestion, not a `500` that tells the sender
 * to re-send a batch which was in fact applied.
 */
async function recordReorgSafely(
	c: Context<{Bindings: Env}>,
	ingestion: LogIngestion,
	reorg: NonNullable<Awaited<ReturnType<LogIngestion['receive']>>['reorg']>,
): Promise<void> {
	if (reorg.cause === 'absence') {
		logger.error(
			`ingest: reverted state from an ABSENCE at block ${reorg.blockNumber} (${reorg.blockHash}) for ` +
				`${JSON.stringify(ingestion.context)}. Absence is an inference, not proof: it is indistinguishable from a ` +
				`sender that under-delivered the range. A rising rate of these means truncation or misconfiguration.`,
			reorg,
		);
	} else {
		logger.info(`ingest: reverted state from a hash contradiction at block ${reorg.blockNumber}`, reorg);
	}
	try {
		await recordReorg(c.get('config').db, reorg);
	} catch (err) {
		logger.error(`ingest: could not record the reorg counter: ${err instanceof Error ? err.message : String(err)}`);
	}
}
