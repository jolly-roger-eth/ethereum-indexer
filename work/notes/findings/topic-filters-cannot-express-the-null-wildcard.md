---
title: '`LogParseConfig.filters` cannot express the `null` topic wildcard, so every filter on a non-first indexed argument needs a cast'
slug: topic-filters-cannot-express-the-null-wildcard
source: 'found by turning the acceptance gate on for examples/ (ADR-0030). Two independent examples -- examples/event-processor-nfts/browser/main.ts and examples/web-demo/src/pages/MyNFTS.svelte -- had both written the same `null` and both had been shipping only because nothing typechecked them. Runtime behaviour read from packages/core/src/internal/decoding/LogEventFetcher.ts and internal/engine/ethereum.ts on etherfold c19fb6b.'
---

`LogParseConfig['filters']` types one filter set as

```ts
[eventName: string]: (`0x${string}` | `0x${string}`[])[][];
```

There is no `null` in it. But `null` is what `eth_getLogs` defines as "match any value in this topic position", and it is the ONLY way to filter on the second or later indexed argument: a filter on `Transfer(from, to, id)`'s `to` has to say "any `from`, this `to`", which is `[null, toTopic]`.

The runtime already supports it. `LogEventFetcher` copies the filter list into `ExtraFilters` and `getLogsWithVariousFilters` passes it through to the `topics` array of the JSON-RPC call unaltered, so a `null` arrives at the node exactly as the method specifies. **The type is narrower than both the runtime and the wire protocol.**

## Why this was invisible

Both places in this repository that filter on a second indexed argument wrote the `null`, and both are browser application code that no gate typechecked (the subject of `example-browser-code-is-typechecked-by-nothing`). `vite build` strips types, so the code ran correctly and the type error existed only in an editor nobody had open. Turning the gate on surfaced both at once, which is also what makes this a finding rather than one example's problem: two authors independently needed the wildcard, so it is the ordinary case and not an edge.

## Not acted on, deliberately

Widening the element type to `(`0x${string}` | `0x${string}`[] | null)[][]` is a one-line change to `packages/core/src/types.ts` and is almost certainly right. It is deliberately NOT made here, because a consumer is about to build against the CURRENT published API (`@etherfold/core@0.7.0`), and a type widened underneath them is a worse surprise than a documented cast. Both call sites now carry the cast with a comment pointing here.

The change to make, when it is made:

- widen `LogParseConfig['filters']`'s element type to admit `null`
- check `ExtraFilters` in `internal/engine/ethereum.ts` alongside it, which has the same narrow shape
- a changeset marking it `minor` on `@etherfold/core` (a widening breaks no caller)
- delete the two casts and this note's "not acted on" section
