---
title: 'Promoting a staging generation: the label belongs in the KEY, and the filesystem is what decides that'
slug: promotion-cost-of-a-two-label-stream
source: 'measured by docs/spikes/promotion-cost-of-a-two-label-stream (run/measure-fs.ts and browser/promotion.spec.ts) against node 24.13.1 and chromium/firefox/webkit under Playwright 1.60, on an AMD Ryzen 7 PRO 6850U writing to ext4, on 2026-08-30'
---

The open question left by `work/notes/ideas/stream-grafting-what-we-established.md`, answered by
measurement rather than argument, because it had already flipped in prose more than once.

**LOAD-BEARING.** `a-reconfigure-is-not-an-outage` puts the generation label in the KEY because of
these numbers. Reversing that choice without re-running the spike is reversing a measurement.

## The question

The two-label design gives every stream entry a label, `live` or `staging`. A staging reader takes
`gen = staging OR (gen = live AND seq <= N)`; promotion deletes the live entries above `N` and
relabels staging to live. On a relational store that is one indexed `UPDATE`. In a key/value store
there is no bulk update, so promotion touches one entry per staging segment, and the question was
where the label should live: in the KEY, where a relabel is a **rename**, or in the VALUE, where it
is a **rewrite**.

The expectation going in was "a rename: cheap on the filesystem, read-plus-write on IndexedDB; in the
value, a rewrite either way". That is right, and it is not the useful part of the answer.

## What was measured

The captured launched game (`stratagems-alpha1`, 31,332 real logs, 23.2 MB of JSON) repeated to
`4x` and `8x`, cut into segments at seal thresholds of 250 / 1,000 / 4,000 events, promoted under
each layout, on both keepers. The three sharing cases decide how much staging wrote: `whole-stream`
(a processor-only or decode-only change) writes nothing, `partial-graft` writes above the boundary,
`no-sharing` (a changed address, a new contract) writes everything.

Both keepers run the same layout code over different ports, so the arms differ only in the substrate.
Value-label was also measured in its BEST form, with a boundary pointer, so the comparison is not a
strawman.

## The findings

### 1. IndexedDB does not decide the question. The filesystem does.

IndexedDB has no rename, so a key-label relabel there is `get` + `set` + `del` — the same
structured-clone round trip a value-label rewrite costs. Measured, the two are the same number, on
all three engines (promotion ms, 8 MB–68 MB of staging, seal 1,000):

| case | staging | key-label | value-label+pointer | | |
| --- | --- | --- | --- | --- | --- |
| | | chromium / firefox / webkit | chromium / firefox / webkit | | |
| partial-graft `4x` | 33.8 MB | 608 / 593 / 282 | 603 / 684 / 265 | | |
| no-sharing `4x` | 67.5 MB | 1636 / 1161 / 619 | 1380 / 1092 / 559 | | |

Within noise of each other. So the browser cannot prefer either layout, and anyone arguing the choice
from IndexedDB is arguing from the substrate that has no opinion.

The filesystem does have one, and it is not marginal. Over a 136 MB stream (`8x`, seal 1,000), on
ext4:

| case | staging segs | key-label | value-label+pointer |
| --- | --- | --- | --- |
| whole-stream | 0 | 0 bytes, 1 ms | 0 bytes, 3 ms |
| partial-graft | 125 | **0 bytes, 20 ms** | 67.7 MB, 566 ms |
| no-sharing | 250 | **0 bytes, 18 ms** | 135.6 MB, 1,829 ms |

A key-label promotion writes **no segment bytes at all**, whatever the size of the history: it is
250 directory-entry updates. That is the finding, and it is a difference in KIND rather than in
degree, which is why it survives any reasonable change to the machine.

> Measured on real ext4, deliberately. `os.tmpdir()` is tmpfs on most Linux boxes, where a rename and
> a rewrite are both memory operations, and measuring there understates the gap. Neither arm calls
> `fsync`, matching the real keeper (`packages/fs/src/utils/fs.ts` does not either); with `fsync` the
> gap would only widen, since a rename dirties one directory block and a rewrite dirties whole files.

### 2. The cost tracks segment COUNT for a key label and total BYTES for a value label

Sweeping the seal threshold at a FIXED 136 MB history is the check that the model is right rather
than the numbers merely being different:

| seal | staging segs | key-label ms | value-label+pointer ms |
| --- | --- | --- | --- |
| 250 | 1,002 | 40 | 1,474 |
| 1,000 | 250 | 18 | 1,829 |
| 4,000 | 62 | 30 | 1,347 |

Key-label stays in the tens of milliseconds across a 16x change in segment count; value-label stays
in the seconds and does not care about the count at all. That is exactly "renames cost per segment,
rewrites cost per byte", so the model holds and the choice of seal threshold is not entangled with
the choice of layout.

### 3. A value label cannot be found without reading the values it is in

This was not anticipated and it is the sharpest of the results. If the label lives in the value, then
discovering which entries are staging requires DESERIALISING EVERY ENTRY — including in the case
where the answer is "none".

The `whole-stream` case relabels nothing, deletes nothing and should be free. Measured without a
boundary pointer, on a 136 MB stream: **820 ms on the filesystem** and 147–423 ms on IndexedDB, to
discover that there was nothing to do. Against 1 ms and 3–15 ms for a key label.

That case is the MOST COMMON reconfigure there is (a processor change; an ABI is regenerated far more
often than it is meaningfully changed), so a value label puts its worst relative cost exactly where
the design most wants zero.

It is avoidable, but only by adding a boundary pointer saying where the live entries end — which
makes the label in the value REDUNDANT (the pointer already answers the question), and introduces a
second source of truth that can disagree with the entries. That is the objection
`appending-to-the-stream-costs-the-batch` already raised when it rejected a head pointer for
enumeration: a pointer over missing segments reads as a hole rather than as the loss it is.

### 4. Promotion is dwarfed by the work that produced it, in every case

The worst case measured is `no-sharing` over a 136 MB history: a key-label promotion is 18 ms on the
filesystem, and 0.6–2.1 s on IndexedDB. But `no-sharing` is by definition a case where the successor
just performed a FULL BACKFILL of that history over `eth_getLogs`, which is minutes. Promotion is
under one percent of the operation it concludes.

In the common case there is nothing to compare, because promotion is free: staging wrote nothing, so
promotion renames nothing and deletes nothing.

So promotion cost does not constrain the design. This is worth stating plainly, because the open
question was posed as though it might: it does not, on either keeper, and the reason it does not is
that **promotion is bounded by what STAGING WROTE, and staging writes nothing in the case that
happens most.**

### 5. Batching neither decides nor rescues anything on IndexedDB

`idb-keyval` ships `getMany`/`setMany`/`delMany`, which collapse a promotion into three transactions
instead of three per segment. Measured against the unbatched form, the results are inconsistent
across engines and within the same order of magnitude either way — at `4x no-sharing`, batching was
1,636 ms vs 835 ms unbatched on chromium but 1,161 ms vs 1,681 ms on firefox. The cost is the
structured clone, not the per-transaction floor, so there is no batching strategy that changes the
answer. (These are single samples of a wall-clock number and should not be read as a ranking; the
point is only that no arrangement of the same reads and writes escapes the clone.)

### 6. A value label forces a HOLE in the ordinal space

Structural rather than measured, and it fell out of implementing both layouts honestly.

With the label in the KEY, live and staging entries occupy separate key spaces, so staging can number
its segments from `N + 1` — the graft point — and promotion is a rename that KEEPS the sequence
number. The promoted stream is contiguous `0..K`.

With the label in the VALUE there is only one key space, so staging cannot reuse `N + 1` (it would
collide with the live entry there) and must append after the live TAIL. Promotion then deletes live
`N+1 .. tail` and keeps staging `tail+1 .. K`, leaving a GAP. Under the contiguity refusal in
`appending-to-the-stream-costs-the-batch` that gap reads as a lost fragment, so a value label forces
either a renumber — which is the per-entry rename it was trying to avoid — or a weaker gap rule that
gives up detecting a partial clear.

Note this is forced, not an implementation choice: any extra key component that separated live from
staging would BE a key label.

## Conclusion

Put the generation label in the KEY. Three of the six findings point that way independently: the
filesystem writes no payload at all (1), the most common case stays genuinely free rather than
costing a full deserialise (3), and the promoted stream stays contiguous so the existing
gap-detection rule keeps working (6). IndexedDB is indifferent (1), so nothing is given up to get
them.

And promotion cost does not constrain the design on either keeper (4), which retires the open
question rather than answering it narrowly.

## What this does NOT say

- Nothing about **whether the unconfirmed window must be stored per boundary or can be
  reconstructed**, the design record's other open question. Untouched here.
- Nothing about **append** cost, which is `appending-to-the-stream-costs-the-batch`.
- The filesystem arm uses plain `JSON.stringify`; the real keeper goes through
  `taggedBnReplacer`/`taggedBnReviver`, which is somewhat slower on both arms and does not move the
  comparison, since the key-label arm serialises nothing.
- Wall-clock numbers are single samples on a loaded laptop and are the weaker evidence throughout.
  The WORK metrics (renames, rewrites, bytes written) are exact and reproduce identically; every
  conclusion above rests on those, with the timings as corroboration.
