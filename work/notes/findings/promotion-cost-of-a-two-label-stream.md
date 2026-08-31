---
title: 'Promoting a staging generation: the label belongs in the KEY, and the filesystem is what decides that'
slug: promotion-cost-of-a-two-label-stream
source: 'measured by docs/spikes/promotion-cost-of-a-two-label-stream @ the commit that landed it alongside this note (run/measure-fs.ts, and browser/promotion.spec.ts driven at SPIKE_SIZES=1x,4x then 8x), against node 24.13.1 and chromium/firefox/webkit under Playwright 1.60, on an AMD Ryzen 7 PRO 6850U writing to ext4, on 2026-08-30. Raw rows in that folder''s results/; re-running the browser half needs SPIKE_SIZES=8x explicitly, since the spec defaults to 1x,4x.'
---

The open question left by `work/notes/ideas/stream-grafting-what-we-established.md`, answered by
measurement rather than argument, because it had already flipped in prose more than once.

> **SUPERSEDED AS AN INPUT, VALID AS A MEASUREMENT.** This answered "where does the generation label
> live?" for a design that put two labels in ONE stream. That design was replaced:
> `a-reconfigure-is-not-an-outage` now gives each generation its OWN stream keyed by its fetch filter,
> so there is no label to place and promotion is a pointer flip. **Nothing here is load-bearing on the
> current design.**
>
> The numbers are unaffected and remain reusable wherever a relabel-or-rewrite question comes up
> again: a rename is free on the filesystem and impossible on IndexedDB; IndexedDB is indifferent
> between the two layouts; and a label in a VALUE cannot be read without deserialising the value.
> Finding 4 also generalises — storage-side promotion cost is dominated by whatever produced the data,
> which is why the pointer flip in the current design is not worth measuring.

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

The captured launched game (`stratagems-alpha1`, 31,332 real logs) repeated to `4x` and `8x`, cut
into segments at seal thresholds of 250 / 1,000 / 4,000 events, promoted under each layout, on both
keepers. Two sizes are quoted for that fixture and they are not the same quantity: the fixture FILE
is 23.2 MB of JSON (it also carries `provenance`, `source` and `lastSync`), while the SEGMENT PAYLOAD
— the events, which is what a promotion moves — is 17.0 MB at `1x` and so 136.1 MB at `8x`. Every
"136 MB stream" below is the payload figure. The three sharing cases decide how much staging wrote: `whole-stream`
(a processor-only or decode-only change) writes nothing, `partial-graft` writes above the boundary,
`no-sharing` (a changed address, a new contract) writes everything.

Both keepers run the same layout code over different ports, so the arms differ only in the substrate.

**Value-label was measured with a boundary pointer as well as without**, so the comparison is not a
strawman. Be precise about what that bounds, though: the pointer removes value-label's DISCOVERY
read, not its relabel, which still rewrites every staging entry. A design where an auxiliary record
is AUTHORITATIVE — promotion moves a boundary and never touches the entries — would move zero payload
bytes, i.e. key-label's own result. That family is excluded by the DESIGN rather than by these
numbers, and for two reasons worth writing down: the live generation keeps appending while staging
builds, so the two generations' ordinals interleave and a single boundary is not even sufficient; and
the design requires that after promotion no entry records which generation wrote it, which rules out
an epoch counter. So these numbers bound value-label, not every conceivable auxiliary-record scheme.

## The findings

### 1. IndexedDB does not decide the question. The filesystem does.

IndexedDB has no rename, so a key-label relabel there is `get` + `set` + `del` — the same
structured-clone round trip a value-label rewrite costs. They are not merely close: **they do
identical work**, and that is reproducible to the byte rather than being a timing observation
(`8x`, seal 1,000, promoting a 136 MB history):

| arm | payloads rewritten | bytes moved | deletes | store ops |
| --- | --- | --- | --- | --- |
| key-label | 250 | 135,562,192 | 250 | 4 |
| value-label+pointer | 250 | 135,565,442 | 250 | 3 |

Identical counts and identical deletes, on chromium, firefox AND webkit, with the same byte totals
reproduced exactly on every engine. The two differences are both structural and both tiny:

- **one batched delete operation**, because a rename has to remove the old key and a rewrite lands on
  the same one;
- **3,250 bytes**, which is 0.002% and is not noise — it is 13 bytes per segment across 250 segments,
  the length of `"gen":"live",`. The value label costs slightly MORE bytes precisely because the
  label is in the bytes. A pleasing confirmation that the arms are doing what they claim, and the
  wrong direction for value-label.

There is nothing else there for a timing to distinguish.

The timings agree and are worth nothing more than that. On this machine the run-to-run spread at `8x`
EXCEEDED the gap between the arms several times over — one webkit `no-sharing` promotion measured
1.4 s in a quiet run and 60 s in a back-to-back sweep, with byte-identical counters — so no ranking
between these two arms should be read out of any wall-clock number here, in either direction.

So the browser cannot prefer either layout, and anyone arguing the choice from IndexedDB is arguing
from the substrate that has no opinion.

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

Value-label is flat in segment count and tracks bytes, which is the half the sweep genuinely
establishes: a 16x change in count moves it not at all.

Be careful about the other half. Key-label's WALL-CLOCK is not monotonic in the count here (40 / 18 /
30 ms), so these timings do not demonstrate "cost per segment" — at this scale they are measuring
noise around a floor. What establishes the per-segment claim is the exact `metadataRenames` counter,
which equals the staging segment count by construction and moves 0 payload bytes at every threshold.
So the honest reading is: key-label stays in the TENS OF MILLISECONDS at any seal threshold and
refuses to grow with bytes, while value-label refuses to shrink with count. The choice of seal
threshold is therefore not entangled with the choice of layout, which is what the sweep was for.

### 3. A value label cannot be found without reading the values it is in

This was not anticipated and it is the sharpest of the results. If the label lives in the value, then
discovering which entries are staging requires DESERIALISING EVERY ENTRY — including in the case
where the answer is "none".

The `whole-stream` case relabels nothing, deletes nothing and should be free.

On the FILESYSTEM this is measured as work, and the work is the whole history: promoting a 136 MB
stream with a value label READS **136.1 MB** and writes nothing, taking **820 ms** to establish that
there was nothing to do. A key label reads 0 bytes and takes **1 ms**.

On IndexedDB only the timing is available, because structured-clone size is not exposed — the same
constraint that makes `appending-to-the-stream-costs-the-batch` count its seal threshold in events
rather than bytes. There the value label takes **0.7–2.1 s** against **6–27 ms** for the key label,
which is one to two orders of magnitude and holds in the same direction on all three engines across
every run, including the noisy ones. The op counters corroborate the mechanism: the value-label arm
issues extra whole-store reads that neither other arm does.

This is the one place a wall-clock number carries weight, and it does so only because the effect is
larger than the noise by more than an order of magnitude, and because the filesystem measures the
same thing as exact bytes.

That case is the MOST COMMON reconfigure there is (a processor change; an ABI is regenerated far more
often than it is meaningfully changed), so a value label puts its worst relative cost exactly where
the design most wants zero.

It is avoidable, but only by adding a boundary pointer saying where the live entries end — which
makes the label in the value REDUNDANT (the pointer already answers the question), and introduces a
second source of truth that can disagree with the entries. That is the objection
`appending-to-the-stream-costs-the-batch` already raised when it rejected a head pointer for
enumeration: a pointer over missing segments reads as a hole rather than as the loss it is.

### 4. Promotion is dwarfed by the work that produced it, in every case

The worst case measured is `no-sharing` over a 136 MB history: a key-label promotion is **18 ms and
0 bytes written** on the filesystem, and on IndexedDB it moves 135.6 MB in 4 store operations, which
took between 1.4 s and 60 s depending on how loaded the machine was. But `no-sharing` is by
definition a case where the successor just performed a FULL BACKFILL of that history over
`eth_getLogs`.

That comparator is an ESTIMATE and is labelled one: this spike never measured a backfill, and "an
`eth_getLogs` backfill of 136 MB takes minutes" is a judgement about the most rate-limited call this
system makes, not a number from `results/`. The comparator the harness DOES record is the local
write: at `4x no-sharing`, seal 1,000, the setup append of live plus staging is 664 / 1720 / 1269 ms
against a key-label promotion of 1580 / 1761 / 1372 ms, so on IndexedDB promotion is the same order
as locally writing the staging it promotes — expected, since a relabel there is `get`+`set`+`del`
against one `set`. The claim rests on the RPC fetch dominating both, which is safe but is reasoning,
not arithmetic over a measured ratio.

In the common case there is nothing to compare, because promotion is free: staging wrote nothing, so
promotion renames nothing and deletes nothing.

So promotion cost does not constrain the design. This is worth stating plainly, because the open
question was posed as though it might: it does not, on either keeper, and the reason it does not is
that **promotion is bounded by what STAGING WROTE, and staging writes nothing in the case that
happens most.**

### 5. Batching neither decides nor rescues anything on IndexedDB

`idb-keyval` ships `getMany`/`setMany`/`delMany`, which collapse a promotion into three transactions
instead of three per segment — a 250x reduction in store operations at `8x no-sharing` (4 against
1,000), which is the largest structural difference any arm in this spike has. It does not show up as
a consistent win: across runs and engines the batched and unbatched forms trade places and stay
within the same order of magnitude, well inside the run-to-run spread documented above.

That is the point, and the op counter is what makes it meaningful rather than inconclusive: cutting
the transaction count by 250x does not move the cost, so the cost is the STRUCTURED CLONE and not the
per-transaction floor. No arrangement of the same reads and writes escapes the clone, so batching is
an implementation preference here and not a lever on this decision. (No ranking between the two forms
should be read out of these timings.)

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
  How much weaker was itself observed: a first `8x` chromium sweep, run while other work was
  competing for the machine, produced key-label timings up to FIVE TIMES those of a quiet re-run,
  with the same exact work counters. The WORK metrics (renames, rewrites, bytes written) are exact
  and reproduce identically; every conclusion above rests on those, with the timings as
  corroboration. Where a timing is the only evidence for a claim, the claim is stated weakly (see
  findings 2, 4 and 5).
- The IndexedDB half was run at `1x`, `4x` and `8x`. The `8x` rows are seal 1,000 only; the seal
  sweep is a filesystem measurement.
