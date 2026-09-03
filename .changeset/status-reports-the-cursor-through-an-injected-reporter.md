---
'@etherfold/server': minor
---

`/status` REPORTS THE CURSOR, through a reporter a host injects beside its database.

**`ServerOptions.getCursorReport` (`@etherfold/server`)** — optional, injected exactly like `getIngestion` and for the same reason: only the process that OWNS the store can read a cursor, and this package has no store dependency at all. It may be async, because reading a cursor is a store read rather than a handle a host already holds. A host with no store (the Cloudflare Worker host is one) injects none, and its `/status` carries no `cursor` field rather than an invented one.

**`GET /status` gains `cursor`** — an OBJECT, never a bare value (ADR-0047): `{reported: true, value}` carrying whatever the reporter returned, unparsed and uninterpreted, or `{reported: false, reason}`. The server owns the envelope and the host owns the contents, because the sync cursor is an opaque string behind the storage seam and only the processor knows what one means (ADR-0027). It is an object so the GENERATION dimension can grow INSIDE it later — an indexer already holds several generations and reports progress per generation, the server does not hold them yet, so a later host adds a key beside `value` instead of re-typing a field clients already read.

- **A reporter owes the server a SMALL, JSON-serialisable summary and never the store's raw serialized cursor**, which is a `LastSync` carrying an unconfirmed window of decoded events. The constraint is stated on the option because `/status` reports verbatim: the server cannot bound what it does not parse. The reporter's return type is JSON-shaped, so a `bigint` does not compile.
- **A reporter cannot take `/status` down.** Throwing, rejecting, having nothing to report, or handing over something that cannot be serialised all degrade to `reported: false` with a reason; none of them fails the request or changes `healthy`, exactly as the reorg counters already degrade in that route. The serialisability probe is deliberate: an unserialisable report would otherwise throw inside `c.json`, where nothing can degrade it, and answer `500` on the page an operator watches while something is wrong.

Nothing in this change wires a real store to a real server: the processes that own one are the CLI's commands, which arrive with `one-command-runs-the-whole-pipeline`.
