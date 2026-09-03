import {logs} from 'named-logs';

const logger = logs('@etherfold/server');

/**
 * What a host's cursor reporter hands over: a SMALL, JSON-serialisable summary
 * of where the pipeline has got to.
 *
 * Typed as JSON rather than as `unknown` on purpose. The server reports this
 * VERBATIM (`/status` places it in the response and never parses it), so the
 * type is the only place the obligation can be stated at all -- and a `bigint`,
 * which is what a decoded `uint256` is throughout this project, would otherwise
 * compile here and then fail `JSON.stringify` on the one page an operator
 * refreshes while something is wrong.
 */
export type CursorReport =
	| string
	| number
	| boolean
	| null
	| readonly CursorReport[]
	| {readonly [key: string]: CursorReport};

/**
 * The `cursor` field on `/status`: an ENVELOPE the server owns, around a value
 * it does not understand.
 *
 * An OBJECT rather than the reported value itself, for two reasons that both
 * outlive this milestone. It carries the DEGRADED case in the field instead of
 * by omission, so an operator can tell "this host reports no cursor" from "this
 * host's reporter is broken". And it is where the GENERATION dimension grows: an
 * indexer already holds several generations and reports progress per generation
 * (`a-reconfigure-is-not-an-outage`), the server does not hold them yet, and a
 * host that later reports several adds a key BESIDE `value` rather than changing
 * the type of a field clients already read (ADR-0047).
 *
 * `value` is typed `unknown` HERE and `CursorReport` at the injection point, and
 * the asymmetry is deliberate twice over. It is what the server actually knows
 * (it reports the value without parsing it), and this type reaches the Hono RPC
 * client type through `c.json`, where a recursive JSON type makes the compiler
 * give up with `TS2589` -- so the serialisability obligation is stated where a
 * HOST writes its reporter, which is the only place that can honour it anyway.
 */
export type StatusCursor = {reported: true; value: unknown} | {reported: false; reason: string};

/**
 * Ask the host's reporter, and never let the answer fail the request.
 *
 * `/status` is the page an operator watches when something is wrong, so every
 * way a reporter can fail -- throwing, rejecting, having nothing to report, or
 * handing over something that cannot be serialised -- degrades to an
 * absent-with-a-reason cursor. Same rule the reorg counters follow in this
 * route, for the same reason: an operational read that could take the health
 * page down would be worse than no operational read.
 *
 * The serialisability probe is the one thing done TO the value, and it is not
 * parsing: it asks whether the report can be SENT, never what it means. Without
 * it an unserialisable report throws inside `c.json` -- after this function has
 * returned, where nothing can degrade it -- and the whole route answers `500`.
 */
export async function reportCursor(
	report: () => CursorReport | undefined | Promise<CursorReport | undefined>,
): Promise<StatusCursor> {
	let value: CursorReport | undefined;
	try {
		value = await report();
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		logger.error(`status: the cursor reporter failed: ${reason}`);
		return {reported: false, reason};
	}

	if (value === undefined) {
		return {reported: false, reason: `the cursor reporter has nothing to report`};
	}

	try {
		JSON.stringify(value);
	} catch (err) {
		const reason = `the cursor report is not JSON-serialisable: ${err instanceof Error ? err.message : String(err)}`;
		logger.error(`status: ${reason}`);
		return {reported: false, reason};
	}

	return {reported: true, value};
}
