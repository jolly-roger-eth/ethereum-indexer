import type {Abi} from 'abitype';
import {IngestionRefusedError, IngestionUnavailableError} from './errors.js';
import type {IngestionResponse, IngestionTarget} from './logFetcher.js';
import {serializeWireBatch} from './streamBuilder.js';
import type {WireBatch} from './types.js';

/**
 * Just enough of `fetch` to post a batch.
 *
 * Narrowed to what is used so that a host can supply its own (a Worker's bound
 * `fetch`, an agent-configured client) and a TEST can hand over the receiving
 * app's own request handler, which is how the round-trip test drives the real
 * server with no socket in between.
 *
 * The return type admits a bare `Response` as well as a promise, because that IS
 * what an in-process handler hands back (Hono's `app.request` among them). It is
 * awaited either way, so the wider type costs nothing and spares every caller an
 * `async` wrapper whose only job is to satisfy this signature.
 */
export type FetchLike = (
	url: string,
	init: {method: string; headers: Record<string, string>; body?: string},
) => Response | Promise<Response>;

export type HttpIngestionOptions = {
	/** The indexer-server's base URL. `/ingest` and `/ingest/expected-from-block` hang off it. */
	endpoint: string;
	/** The server's `INGEST_TOKEN`. Sent as a bearer token and never logged, thrown or reported. */
	token: string;
	/** Defaults to the global `fetch`, which every targeted runtime has. */
	fetch?: FetchLike;
};

/**
 * The ADR-0004 wire, over HTTP.
 *
 * Its entire job is turning a status code into one of the three things a sender
 * can act on, and it is the only place in this package that knows which code
 * means what:
 *
 * - **200** -- applied, and the body says where the next batch starts.
 * - **409** -- the one RESUMABLE refusal. Returned as a `CursorCorrection`
 *   rather than thrown, because it is not an error: it is how a fetcher holding
 *   no cursor is told where it really is.
 * - **anything else 4xx (400 malformed or foreign, 401 bad token, 501 no
 *   processor)** -- `IngestionRefusedError`. No block number makes these right,
 *   so a sender that retried them would retry forever.
 * - **5xx, or no answer at all** -- `IngestionUnavailableError`, which IS worth
 *   retrying. The batch may or may not have been applied; the sender does not
 *   need to know, because the cursor settles it on the next attempt.
 *
 * The body is written with `serializeWireBatch`, never `JSON.stringify`: a
 * decoded log's `args` hold a BigInt for every `uint256` an ABI declares, which
 * `JSON.stringify` throws on outright.
 */
export function createHttpIngestion(options: HttpIngestionOptions): IngestionTarget {
	const base = options.endpoint.replace(/\/+$/, '');
	const doFetch: FetchLike =
		options.fetch ??
		((url, init) => {
			if (typeof fetch !== 'function') {
				throw new Error(`no global fetch in this runtime: pass one to createHttpIngestion`);
			}
			return fetch(url, init);
		});

	async function post(path: string, body?: string): Promise<{status: number; body: any; text: string}> {
		const headers: Record<string, string> = {Authorization: `Bearer ${options.token}`};
		if (body !== undefined) {
			headers['Content-Type'] = 'application/json';
		}
		let response: Response;
		try {
			response = await doFetch(`${base}${path}`, {method: 'POST', headers, body});
		} catch (err) {
			// A transport failure, not a refusal: the server may be restarting, the
			// network may be down, and both are worth another attempt. The message never
			// echoes the request, so the token cannot ride out in a log line.
			throw new IngestionUnavailableError(
				`could not reach the indexer-server at ${base}${path}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		// read as TEXT and parse loosely: an error from a proxy in front of the
		// server is HTML, and `response.json()` on it throws something that reads
		// like a bug in this client
		const text = await response.text();
		let parsed: any = undefined;
		try {
			parsed = text ? JSON.parse(text) : undefined;
		} catch {
			parsed = undefined;
		}
		return {status: response.status, body: parsed, text};
	}

	function messageOf(body: any, text: string): string {
		return typeof body?.message === 'string' ? body.message : text.slice(0, 200);
	}

	function refusalFor(status: number, body: any, text: string, path: string): Error {
		if (status >= 500) {
			return new IngestionUnavailableError(
				`the indexer-server answered ${status} to ${path}: ${messageOf(body, text)}`,
				status,
			);
		}
		const code = typeof body?.error === 'string' ? body.error : 'unrecognised-refusal';
		const hint =
			status === 401
				? ` The server's INGEST_TOKEN is unset or does not match the one this fetcher presents.`
				: status === 501
					? ` This server hosts no processor, so it has no cursor to advance.`
					: '';
		return new IngestionRefusedError(status, code, `${messageOf(body, text)}${hint}`);
	}

	return {
		async expectedFromBlock() {
			const path = '/ingest/expected-from-block';
			const {status, body, text} = await post(path);
			if (status !== 200) {
				throw refusalFor(status, body, text, path);
			}
			if (typeof body?.expectedFromBlock !== 'number') {
				throw new IngestionRefusedError(
					status,
					'malformed-answer',
					`${base}${path} answered 200 without an expectedFromBlock number. Is this an etherfold indexer-server?`,
				);
			}
			return {expectedFromBlock: body.expectedFromBlock, context: body.context};
		},

		async send(batch: WireBatch<Abi>): Promise<IngestionResponse> {
			const path = '/ingest';
			const {status, body, text} = await post(path, serializeWireBatch(batch));

			if (status === 200 && body?.success) {
				if (typeof body.expectedFromBlock !== 'number') {
					// Checked on the ACCEPTED path as well as the refused one, and for the same
					// reason: this number is the sender's whole idea of where it is next time.
					// Taken unchecked, an `undefined` here would be cached as the hint and
					// reported inside an outcome that types it as a number, so the lie would
					// surface somewhere else entirely.
					throw new IngestionRefusedError(
						status,
						'malformed-answer',
						`${base}${path} accepted a batch without saying where the next one starts. ` +
							`Is this an etherfold indexer-server?`,
					);
				}
				return {
					accepted: true,
					expectedFromBlock: body.expectedFromBlock,
					applied: body.applied ?? 0,
					retracted: body.retracted ?? 0,
					reorg: body.reorg,
				};
			}

			if (status === 409) {
				if (typeof body?.expectedFromBlock !== 'number') {
					// A 409 without the number is not resumable, whatever it meant to be:
					// there is nowhere to re-send from. Refuse loudly rather than guess.
					throw new IngestionRefusedError(
						status,
						'malformed-correction',
						`a 409 arrived without an expectedFromBlock, so there is nothing to re-send from: ${messageOf(body, text)}`,
					);
				}
				return {accepted: false, expectedFromBlock: body.expectedFromBlock};
			}

			throw refusalFor(status, body, text, path);
		},
	};
}
