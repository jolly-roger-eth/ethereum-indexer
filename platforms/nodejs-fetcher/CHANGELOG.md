# @etherfold/platform-nodejs-fetcher

## 0.1.0

### Minor Changes

- 31833b6: A host for the log-fetcher: the Node loop, and the policy every host shares.

  `LogFetcher` (`@etherfold/core`) answers what a fetch cycle IS and deliberately says nothing about when one runs. These packages are the layer above.

  **`@etherfold/fetcher-host`** is everything a host needs that is NOT scheduling, so that it exists once rather than once per runtime: the configuration a deployment supplies, the classification of a cycle into the five things a scheduler can act on, the wait after each, and the loop that drives them. `runFetcherLoop` runs cycles back to back while there is known work left and settles into a poll interval at the tip.

  **Three of the five outcomes are not failures.** `progress` and `idle` (`up-to-date`: the chain has produced nothing above the cursor) are ordinary, and so is `contended` (`yielded`: the cycle was corrected repeatedly without landing, which is what redundant fetchers do to each other) -- it backs off on an escalating, jittered curve and is raised to a warning only after a RUN of them, since one is normal and a run is a signal. The split between `retry` and `fatal` is read off the error's own `retryable` flag and is never re-derived from a status code or a message: an unreachable server escalates and keeps going, while a bad token, a foreign `{source, config}`, the wrong chain or a suspected truncation stops the host, because no waiting makes those right.

  **`@etherfold/platform-nodejs-fetcher`** adds a process and nothing else: `startFetcher()` returns a handle, `SIGINT`/`SIGTERM` let the cycle in flight finish, and `etherfold-fetch` exits `1` when it stopped on a refusal, because a fetcher that stays up while achieving nothing is indistinguishable from a working one until somebody reads the state it is not producing.

  **It holds no cursor, and has nowhere to put one.** Progress across restarts comes from the indexer-server's expected cursor and from nothing else (ADR-0004): every run's first act is to ask, and a `409` is the correction path rather than an error. This is tested rather than assumed. A fetcher is killed with a cycle in flight, between reading the logs and delivering them, and replaced by one carrying nothing; every log still lands exactly once, over real HTTP, with no operator involved.

  **Set `SUSPECT_RESULT_COUNT` to your node's real `eth_getLogs` cap.** Silent truncation is detectable only by matching the cap exactly, so a node capping at anything other than the default 10000 pushes a short range as a complete one, which the receiver reads as an absence, and an absence is a reorg. It is resolved INDEPENDENTLY of `MAX_EVENTS_PER_FETCH`: lowering how much a fetcher asks for (the only lever a host has over batch size) must not quietly lower what it treats as a capped answer.

  Credentials come from configuration and are never written. `INGEST_TOKEN` appears in no log line and in no error message; `ETH_NODE_URI` and `INGEST_ENDPOINT` are logged host-only, since `.../v2/<api-key>` is the standard shape at every hosted provider.

  **There is deliberately no serverless fetcher, and only one schedule shape.** Driving the chain needs a host that can hold a process: a serverless trigger fires on a schedule rather than continuously, caps an invocation well below what a first sync takes, and holds a whole batch in memory while it is built. A serverless runtime is a good home for the RECEIVING half, whose work is short and per-request, and this half runs where a loop can.

  What does vary is where the batch goes, and it arrives as one dependency. `createHttpIngestion` pushes to an indexer-server elsewhere; `createDirectIngestion` (new in `@etherfold/core`) hands it to a stream-builder in the same process, so a single Node deployable runs both halves. `endpoint` and `token` are consequently optional and are demanded only by a host that will actually push over HTTP: a combined one has no network to point at and nobody to authenticate to. A test drives both shapes over the same chain, reorg included, and asserts they land in the same state.

### Patch Changes

- Updated dependencies [6c875dd]
- Updated dependencies [535ccc1]
- Updated dependencies [0957f8c]
- Updated dependencies [c681b79]
- Updated dependencies [9d21d67]
- Updated dependencies [ca6f981]
- Updated dependencies [31833b6]
- Updated dependencies [047cd73]
- Updated dependencies [31833b6]
- Updated dependencies [eba61c3]
- Updated dependencies [dece521]
- Updated dependencies [939364a]
- Updated dependencies [d24872f]
- Updated dependencies [78d8377]
- Updated dependencies [3de4c35]
- Updated dependencies [bc118e4]
- Updated dependencies [bc5d71a]
- Updated dependencies [e0a6480]
- Updated dependencies [9738f1c]
- Updated dependencies [33afc5b]
- Updated dependencies [4097ccd]
- Updated dependencies [e0e5832]
- Updated dependencies [3a78285]
- Updated dependencies [0ac08c0]
- Updated dependencies [cefe0de]
  - @etherfold/core@0.7.0
  - @etherfold/fetcher-host@0.1.0
