import {Hono} from 'hono';
import type {Context} from 'hono';
import {logs} from 'named-logs';
import type {Env} from '../env.js';
import {encodeFeedCursor, openFeedCursor, STREAM_FEED_VIEW, type FeedCursorRefusal} from '../feed/cursor.js';
import {FEED_START_POSITION, readStreamFeed} from '../feed/stream.js';
import {resolveIndexer} from './resolve.js';
import {setup} from '../setup.js';
import type {ServerOptions} from '../types.js';

const logger = logs('@etherfold/server');

/**
 * The DEFAULT page a caller that asked for no size gets.
 *
 * Small enough that the obvious first call is cheap on a stream with millions of
 * rows, and large enough that a consumer polling a quiet chain is caught up in
 * one round trip.
 */
const DEFAULT_PAGE_SIZE = 100;

/**
 * The largest page this server will serve, and a hard REFUSAL rather than a
 * silent clamp.
 *
 * A clamp is accept-and-ignore, which this repo does not do: a caller asking for
 * 100,000 and receiving 1,000 has been answered with something it did not ask
 * for, and the one thing it can check -- the count it got back -- looks exactly
 * like "that is all there was". Refusing states the bound instead, and the caller
 * fixes its configuration once.
 */
const MAX_PAGE_SIZE = 1000;

/**
 * THE RETRACTION-AWARE FEED (ADR-0006, the first of the two views over the stored
 * emission stream).
 *
 * `GET /{indexer}/feed` serves the stream in `seq` order, retractions INCLUDED,
 * resuming from a cursor the CALLER holds. This is the view for a consumer that
 * WANTS to see reorgs -- it acts optimistically on a log and cancels the pending
 * action when the retraction arrives -- so nothing is filtered out of it. The
 * `alive` flag and a block gate belong to the OTHER view, which exists so that a
 * consumer never has to hear the word reorg.
 *
 * ## It is a PUBLIC read, and deliberately not behind the ingest token
 *
 * `INGEST_TOKEN` guards the FETCHER's private API -- the routes that can move the
 * cursor -- and it is registered on the ingest path for exactly that reason. A
 * consumer is a third party built outside etherfold (ADR-0005) that etherfold
 * stores nothing about, so putting the feed behind the fetcher's deployment
 * secret would mean handing every consumer the credential that can WRITE. This
 * route therefore answers anonymously, like `/status`. A deployment that needs
 * the feed private puts it behind its own edge, which is where an authorisation
 * model that knows about consumers belongs.
 *
 * ## Why this route needs the REGISTRY
 *
 * To validate a cursor's stream it must know WHICH stream is being served, and
 * the only thing that knows is the receiver registered under the name
 * (`LogIngestion.streamDigest`). The table cannot answer it: one indexer's rows
 * may span several streams over its life, nothing in them says which is current,
 * and picking one by a heuristic is the plausible wrong answer this whole design
 * refuses. So a host built with no registry answers `501` here for the same
 * reason it does on ingest -- it was built with no named indexers at all -- and
 * `etherfold serve`, the read tier, therefore does not serve this feed today.
 */
export function getFeedAPI<CustomEnv extends Env>(options: ServerOptions<CustomEnv>) {
	return new Hono<{Bindings: CustomEnv}>().use(setup({serverOptions: options})).get('/:indexer/feed', async (c) => {
		const resolved = resolveIndexer(options, c as never, 'feed');
		if (!resolved.ok) return resolved.response;
		const {name} = resolved;
		// WHICH stream this name serves right now. Read once and used both to
		// validate the cursor and to key the read, so the two cannot disagree.
		const stream = resolved.entry.ingestion.streamDigest;

		const limit = pageSizeOf(c.req.query('limit'));
		if (!limit.ok) {
			return c.json(
				{success: false, error: 'invalid-limit', maxLimit: MAX_PAGE_SIZE, message: limit.message} as const,
				400,
			);
		}

		let after = FEED_START_POSITION;
		const presented = c.req.query('cursor');
		if (presented !== undefined) {
			const opened = openFeedCursor(presented, {view: STREAM_FEED_VIEW, indexer: name, stream});
			if (!opened.ok) return refuse(c as never, opened.refusal, {indexer: name, stream});
			const seq = opened.envelope.at['seq'];
			// the right view carrying a position that is not one: a cursor this server
			// cannot have written, so it is unreadable rather than out of range
			if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) {
				return refuse(c as never, {kind: 'unreadable'}, {indexer: name, stream});
			}
			after = seq;
		}

		const page = await readStreamFeed(c.get('config').db, {indexer: name, stream, after, limit: limit.value});

		return c.json({
			success: true,
			// the STREAM these logs belong to: readable, comparable, and the same value
			// the stream-mismatch refusal names, so a consumer that re-subscribed can
			// confirm where it landed. It says WHICH LOGS and deliberately nothing
			// about which FOLD produced any state beside them.
			stream,
			entries: page.entries,
			// a cursor is ALWAYS handed back, including on an empty page, so a
			// caught-up poller keeps a valid position rather than having to remember
			// the last one it was given
			cursor: encodeFeedCursor({view: STREAM_FEED_VIEW, indexer: name, stream, at: {seq: page.position}}),
			hasMore: page.hasMore,
		} as const);
	});
}

/**
 * How big a page the caller asked for, or why the request cannot be served.
 *
 * Absent means the default. Present means a whole number in `[1, MAX_PAGE_SIZE]`
 * and nothing else: a fraction, a zero, a negative and a word are all a caller
 * that believes something untrue about this endpoint, and answering any of them
 * with a default would hide the belief rather than correct it.
 */
function pageSizeOf(asked: string | undefined): {ok: true; value: number} | {ok: false; message: string} {
	if (asked === undefined) return {ok: true, value: DEFAULT_PAGE_SIZE};
	const value = Number(asked);
	if (asked.trim() === '' || !Number.isInteger(value) || value < 1) {
		return {
			ok: false,
			message: `limit must be a whole number of at least 1, and was ${JSON.stringify(asked)}`,
		};
	}
	if (value > MAX_PAGE_SIZE) {
		return {
			ok: false,
			message:
				`limit must be at most ${MAX_PAGE_SIZE}, and was ${value}. It is refused rather than reduced, so that ` +
				`a short page always means the stream is short and never that the server quietly served less.`,
		};
	}
	return {ok: true, value};
}

/**
 * Turn a cursor refusal into the answer a consumer acts on.
 *
 * All four are `400`: the caller presented something this server will not honour,
 * and no amount of waiting or re-presenting the same cursor changes that.
 * Deliberately NOT `409`, which on the ingest side means the ONE resumable
 * refusal (re-send from `expectedFromBlock`, ADR-0004); re-using that number here
 * for something that is not resumable would make a sender's and a consumer's
 * contracts say different things with one code.
 *
 * The four are kept apart because the recovery differs, and because two of them
 * must NOT say more than they do:
 *
 * - `invalid-cursor` says nothing about WHY, on purpose. Truncated, edited,
 *   invented and written-by-an-older-build are one answer, because telling them
 *   apart would tell a client about the encoding, which is the one thing an
 *   opaque cursor must not leak.
 * - `indexer-mismatch` names the indexer the caller ADDRESSED and never the one
 *   its cursor was minted at. Echoing that back would both confirm the encoding
 *   carries a name and hand one tenant's name to a caller poking at another.
 * - `view-mismatch` is a cursor from the canonical view, whose positions count in
 *   `(blockNumber, logIndex)` rather than in `seq`. Two views, one codec, and
 *   this is what keeps the shared codec from serving one view's number as the
 *   other's.
 * - `stream-mismatch` is the one that is nobody's bug, so it is the one that
 *   ANSWERS: the current stream's identity, and a cursor at the position its feed
 *   starts at. It is explicitly NOT a correction to an earlier point on the
 *   caller's own stream -- there is no fork block, because the logs a filter
 *   change produces were never on the stream the cursor names -- so re-subscribing
 *   is a decision the consumer takes rather than a step it can automate blindly.
 */
function refuse(c: Context<{Bindings: Env}>, refusal: FeedCursorRefusal, served: {indexer: string; stream: string}) {
	switch (refusal.kind) {
		case 'foreign-indexer':
			logger.info(`feed: a cursor minted at another named indexer was presented at ${JSON.stringify(served.indexer)}`);
			return c.json(
				{
					success: false,
					error: 'indexer-mismatch',
					indexer: served.indexer,
					message:
						`this cursor was minted at a different named indexer and is not a position here. Two named ` +
						`indexers can hold byte-identical streams, so a position in one means nothing in the other and ` +
						`is refused rather than re-interpreted. Read this indexer's feed from the beginning, or present ` +
						`a cursor it gave you.`,
				} as const,
				400,
			);
		case 'foreign-view':
			return c.json(
				{
					success: false,
					error: 'view-mismatch',
					view: STREAM_FEED_VIEW,
					message:
						`this cursor belongs to another view of the same stream, whose positions are not positions here. ` +
						`Present a cursor this feed gave you, or read it from the beginning.`,
				} as const,
				400,
			);
		case 'foreign-stream':
			logger.info(`feed: a cursor for a stream ${JSON.stringify(served.indexer)} no longer serves was presented`);
			return c.json(
				{
					success: false,
					error: 'stream-mismatch',
					// the two things a consumer needs in order to re-subscribe DELIBERATELY:
					// which stream is served now, and where its feed begins
					stream: served.stream,
					startCursor: encodeFeedCursor({
						view: STREAM_FEED_VIEW,
						indexer: served.indexer,
						stream: served.stream,
						at: {seq: FEED_START_POSITION},
					}),
					message:
						`this cursor is a position in a stream this indexer no longer serves. A position in one stream is ` +
						`unrelated to the same number in another, so it is refused rather than continued. The stream ` +
						`served now is reported as \`stream\`, and \`startCursor\` is the position its feed begins at: ` +
						`present it to follow the current stream from the start. Nothing here points back into your old ` +
						`stream, because the logs served now were never on it.`,
				} as const,
				400,
			);
		default:
			return c.json(
				{
					success: false,
					error: 'invalid-cursor',
					message:
						`this is not a cursor this server issued. A feed cursor is opaque and is only ever obtained from ` +
						`a feed response: present one unchanged, or omit it to read from the beginning.`,
				} as const,
				400,
			);
	}
}
