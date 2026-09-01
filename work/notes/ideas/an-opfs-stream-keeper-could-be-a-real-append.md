---
title: 'An OPFS stream keeper could be a REAL append, and the gate that held it is gone'
slug: an-opfs-stream-keeper-could-be-a-real-append
---

A named follow-up, deliberately not built. It was originally about the FILESYSTEM keeper and gated on
the unconfirmed window being stripped; **both premises have since changed**, and the honest rewrite is
shorter than the original.

## What changed under it

- **The filesystem keeper is GONE.** `keepStreamOnFile` had zero callers, the CLI never used
  `@etherfold/fs`, and filesystem stream storage is not supported. So this is no longer a
  near-term optimisation of a shipping keeper.
- **The GATE is gone.** The gate was that appending a cursor line per save would accumulate an
  `unconfirmedBlocks` per save. A stream keeper now stores NO window at all (ADR-0035 as amended), so
  a cursor record is three block numbers and a context hash. Nothing is waiting on anything.

## What survives, and why it is worth keeping

The IndexedDB keeper already achieves the goal a different way: one segment per batch, no tail,
nothing ever rewritten. So a save already costs exactly its batch. **The append idea is therefore no
longer about cost; it is about what a FILE-SHAPED substrate would want if one arrives.**

The plausible one is **OPFS** (the browser's Origin Private File System), which is worth naming
because it is the reason not to conclude "file-shaped storage is dead here". If an OPFS keeper is
ever written:

- A segment can be a newline-delimited JSON file appended to, so a save is one append rather than a
  read-modify-write, and a crash-torn TRAILING line is detectable by framing.
- OPFS is NOT `node:fs`: it is `FileSystemSyncAccessHandle`, with its own sync-access rules inside a
  worker. So the transferable part was never the node keeper's code — it is the SEGMENT LOGIC in the
  shared helper, which is substrate-neutral by construction. That is the argument for having kept a
  helper at all rather than inlining it into one keeper.
- It needs NO seam change: `commit-segment-with-cursor` is already a KEEPER operation, so it can be
  an append there and a `setMany` on IndexedDB without the helper knowing which.

## What it does NOT change

The address (`['stream', <indexer-name>, <streamDigest>, <ordinal>]`), the read being a full ordered scan, the
contiguity refusal and its recovery, or the three cursor-contract properties. Any file-shaped keeper
inherits all of those unchanged, which is the point.
