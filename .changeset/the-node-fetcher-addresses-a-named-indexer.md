---
'@etherfold/platform-nodejs-fetcher': minor
---

THE NODE FETCHER ADDRESSES A NAMED INDEXER, through `INDEXER_NAME`.

No code changes here: the variable is read by `@etherfold/fetcher-host`, which this adapter already resolves its whole configuration through, and it may equally be passed to `startFetcher` as an override. What changes is that a SPLIT deployment now needs it: the receiving server's routes are `/{indexer}/ingest` and `/{indexer}/ingest/expected-from-block`, a host registers the names it was built with and defaults none, so a fetcher started without a name refuses at construction naming the variable, exactly as it already does for `INGEST_ENDPOINT` and `INGEST_TOKEN`. A COMBINED host, which pushes through `createDirectIngestion` and addresses no route, is asked for nothing.
