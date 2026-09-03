---
'@etherfold/platform-nodejs': minor
---

THE NODE SERVER STARTS ON A DATABASE HANDLE IT WAS GIVEN, and carries a host's ingestion and cursor reporter through to the app.

**`StartOptions.db` accepts a `RemoteSQL` as well as a libSQL URL** — one option, two forms, because a host has one database and the only question is who OPENED it. The URL form is unchanged in every respect (same defaulting to `DB` then `file:./etherfold.db`, same schema auto-setup, same returned handle, same shutdown). The handle form is what makes "one process, one database" true: a process that folds a processor into a store hands the SAME handle to the server, so the store's writes are what the server reads. Two handles onto one URL would be two connections with two views of it — against `:memory:` not even the same database — and two schema-setup races.

**A handle the adapter was GIVEN is not its to close.** `close()` stops the HTTP listener and leaves the database alone, so shutting the server down never takes a store's connection with it. Whoever built the handle closes it.

**`StartOptions.getIngestion` and `StartOptions.getCursorReport`** — the two capabilities only a HOST can build, accepted in `@etherfold/server`'s own shape (resolved per request, since that is what the Workers model forces on the app) and handed to it unchanged. With an ingestion supplied, a server started here can host a processor and its `/ingest` routes work; with none, they answer `501` to an authenticated caller exactly as they do today, and `401` to an unauthenticated one, since the token guard sits on the path ahead of the capability. With a reporter supplied, `/status` reports the cursor; with none, it carries no `cursor` field rather than an invented one.

This adapter still builds no processor, names no store package and knows no chain concept: it decides what the app's database, environment, ingestion and reporter ARE, and nothing else.
