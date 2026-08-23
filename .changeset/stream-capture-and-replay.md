---
'@etherfold/core': minor
'@etherfold/fs': minor
---

Capture an event stream once, replay it forever, with no node in the loop.

Indexing was reproducible only in the sense that the chain does not change: every run re-fetched, so two runs saw different bytes whenever a node paginated differently, rate-limited, or simply moved on. That makes a benchmark unfair between candidates, a processor test slow and flaky, and "the same input" impossible to say out loud.

- **`captureStream(provider, source, {toBlock, ...})`** fetches a range once through the same `LogEventFetcher` the live path uses, and returns a `StreamFixture`: format version, provenance (`capturedAt`, chain, block range, plus whatever the caller adds (contracts commit, node, run)), the `IndexingSource` it was captured for, the cursor, and the decoded events. `toBlock` must be a number, never `'latest'`: a snapshot whose upper bound was "whenever it ran" cannot be re-captured and compared against itself.
- **`serializeStreamFixture` / `parseStreamFixture`** move it as text, with BigInt event arguments surviving via the `"123n"` convention already used by every storage adapter here. Parsing refuses an unknown format or a missing field up front, where the message can still name the fixture.
- **`replayStream(fixture)`** is an `ExistingStream` over a fixture, so the seam the indexer already consults before fetching can be pointed at a file. It never writes: a replay that appended to its own input would stop being a replay of the thing whose provenance is recorded at the top of it.
- **`replayFixtureInto(processor, fixture, streamConfig)`** drives a processor over the fixture with no provider at all, **one block per `process` call**, because that is how blocks arrive and how they are applied. `chainTip: 'live' | 'final'` chooses whether each block is presented as the tip (keeping the processor's reorg-eligible path, and so its history, doing what it did live) or as already final.
- **`blocksOf(fixture)`** groups a fixture into the blocks it contains, in order, for callers that want to drive the batching themselves.
- **`@etherfold/fs`** gains `saveStreamFixture` / `loadStreamFixture`, indented by default because a fixture is a committed artifact that gets read and diffed, and **gzipped when the path ends in `.gz`**. That last part is not a convenience: a real capture is 20.5 MB of JSON and 0.6 MB gzipped, git stores both at about 0.6 MB, so the compressed form costs nothing in the repository and saves 20 MB in every working tree.

Additive: nothing existing changes behaviour.
