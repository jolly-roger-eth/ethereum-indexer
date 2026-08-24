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
