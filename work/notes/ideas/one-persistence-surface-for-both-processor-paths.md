---
title: One persistence surface for both processor paths, instead of a keeper beside a store
slug: one-persistence-surface-for-both-processor-paths
---

Two persistence models are about to live side by side, and only one of them was designed on purpose.

The entity path will persist through `StateStore`: declared entities as versioned rows, plus (per `backend-neutral-entity-event-processor`) the sync cursor written in the same transaction as the block it describes. The free-form `js-processor` path persists through an injected `KeepState`, which writes `AllData = {state, lastSync}` as a single keyed value (`packages/browser/src/storage/state/OnIndexedDB.ts` does one `set()` of the whole object; `packages/cli/src/keepState.ts` writes a file).

**Both honour the same invariant** — state and cursor advance together or not at all — by different mechanisms: a transaction on one side, a single-key write on the other. That invariant is the thing worth protecting, and neither mechanism is wrong.

What is worth revisiting is that `KeepState` has the shape it does because, when it was written, an injected keeper was the ONLY way a free-form processor could persist anything. That premise has expired. `@etherfold/state-store-indexeddb` now exists, an IndexedDB transaction can span object stores, and a browser deployment running the entity path already opens a database that the free-form path's blob could sit in. Nothing forces the two paths to use unrelated substrates any more.

So there may be a better shape: one persistence surface per deployment, with the cursor story told once, and the keeper reduced to the blob-writing it actually does rather than being the whole persistence story for its path. A concrete pull is that a browser app running both a free-form processor and an entity processor currently opens two unrelated stores and has two independent answers to "how far have I got".

Reasons this is an idea and not a task, yet:

- The free-form path's state is an opaque `ProcessResultType`. `StateStore` is about DECLARED entities, and backing arbitrary nested object mutation with versioned rows is exactly what `sql-backed-event-processor` rejected and what this spec's direction-of-constraint argument rests on. So the shared surface would have to be something narrower than `StateStore`, not `StateStore` itself.
- It touches the public API of `@etherfold/js-processor`, `@etherfold/browser` and `@etherfold/cli`, all published.
- It is worth nothing until the entity path is actually wired end to end. The shape of the right answer will be much clearer once `backend-neutral-entity-event-processor` and `index-in-the-browser-with-a-chosen-backend` have landed and one deployment has really used both.

The trigger to revisit: an application that runs both processor kinds in one deployment, or the first time someone has to explain to a newcomer why there are two unrelated ways to persist an indexer's progress.

## The BigInt convention rides on this same fault line

Added 2026-08-25, after `tagged-bigint-codec-across-storage-adapters` landed (ADR-0029), because the two questions turn out to be the same question and should not be rediscovered separately.

There are three ways a persisted BigInt can survive a text boundary, not two:

1. **A suffix** (`"123n"`) — infer the type from the SHAPE of the value. Irreducibly ambiguous, because `"123n"` is both what `123n` serializes to and a legal string a contract can emit. Removed by ADR-0029, and it should stay removed.
2. **A tag** (`{"__bigint__": "123"}`) — the VALUE declares itself. What ships today. It is unambiguous for anything this repository realistically persists, though not absolutely so: viem decodes a tuple into an object with named components, so a single-component tuple named `__bigint__` would revive as a BigInt. Exotic, and worth knowing the guarantee is "no plausible value collides" rather than "none can".
3. **Schema-driven** — no in-band marker at all. The reader knows from the ABI that `args.tokenId` is a `uint256` and converts that field, so nothing needs to be self-describing. `tagged-bigint-codec`'s own migration script did exactly this, and refused to convert any value whose declared type was not an integer, which is evidence it works.

**Option 3 is strictly better where a declaration exists, and impossible where one does not — which is precisely the split this note is about.** Checked against what the keepers actually write:

| persisted | schema | schema-driven? |
| --- | --- | --- |
| `LastSync.unconfirmedBlocks[].events[].args` | the ABI | yes |
| entity rows | declared fields and types | yes |
| `AllData.state` (`ProcessResultType`) | **none, by construction** | no |

Every other number in `LastSync` is a plain `number`, so for the cursor the ABI reaches every BigInt there is. What it cannot reach is the free-form path's state, which is an arbitrary object where a BigInt may sit anywhere — and that is not an oversight in that path, it is what the path IS.

So the tag is not a permanent answer, it is the answer for as long as an untyped blob is persisted. **If the free-form path ever moves onto a store-shaped substrate — the thing this note proposes — the last consumer of a self-describing tag goes with it**, and the encoding can become schema-driven everywhere: no wrapper objects, smaller payloads, and one less convention to explain. Snapshot size is already a measured concern (45.6 KB of current rows against 304.6 KB with history, `docs/spikes/bootstrap-an-entity-store-from-a-snapshot/`), so that is a real gain rather than a tidiness one.

Not a task, and deliberately not one now: the tag landed with a proof that no state moved, and swapping conventions again would pay that cost twice for a benefit that only arrives with the persistence-surface change above. Recorded so the direction is known, and so that nobody re-proposes the suffix on the grounds that the tag is verbose.
