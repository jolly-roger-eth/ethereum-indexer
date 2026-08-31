---
title: 'A quota failure does not tear an IndexedDB transaction, IndexedDB compresses ~8x, and `storage.estimate()` cannot be used to size a cap'
slug: browser-storage-headroom-for-generations
source: 'measured by docs/spikes/generation-storage-headroom-in-the-browser/browser (playwright, chromium/firefox/webkit under Playwright 1.60, quota forced down via CDP Storage.overrideQuotaForOrigin), against the stratagems-alpha1 fixture on an AMD Ryzen 7 PRO 6850U, 2026-08-31. Raw rows in that folder results/.'
---

Three questions asked of the browser before `a-reconfigure-is-not-an-outage` fixes its
`maxGenerations` cap and relies on an atomic segment-plus-cursor commit. Two answers are reassuring
and one is a constraint.

## 1. A QuotaExceededError does NOT tear a transaction — the load-bearing answer

`a-reconfigure-is-not-an-outage` commits a stream segment and its cursor in ONE `setMany`
transaction, precisely so nothing can separate the cursor from the events it describes. That
guarantee is worth exactly as much as it holds under the failure mode a browser actually produces,
which is not a crash but a full disk.

Forced with a real 8 MB quota (CDP `Storage.overrideQuotaForOrigin`), writing the real history until
it refused: chromium threw `QuotaExceededError` mid-run, and the failing commit was **all or
nothing** — highest surviving segment `6`, cursor value `6`, `tearDirection: none`. The cursor was
neither ahead of its segment nor behind it.

So the atomic-commit rule survives a quota failure, and the cap does not need a storage-side sibling
to protect it. Had it torn, the cursor-ahead direction would have been silent data loss and the whole
commit design would have needed rethinking.

> **The detector for this had to be fixed before the result could be believed, and the first version
> reported a false positive.** Counting surviving KEYS cannot detect a tear, because the cursor is one
> key OVERWRITTEN on every commit while segments accumulate, so the counts differ by design. What
> identifies the pair is the cursor's VALUE, which records the segment index it was committed with: a
> commit was whole iff the highest surviving segment index equals the cursor's. Recorded because the
> first run "failed" and the honest reading was that the instrument was wrong, not the browser.

## 2. IndexedDB compresses about 6–10x, so payload size wildly overstates storage cost

Three generations of the fixture, seal 1,000, at `2x` (106.2 MB of JSON payload written):

| engine | payload written | `estimate().usage` | ratio | `estimate().quota` |
| --- | --- | --- | --- | --- |
| chromium | 106.2 MB | 11.0 MB | 9.7x | 5.4 GB |
| firefox | 106.2 MB | 17.3 MB | 6.1x | 1.6 GB |
| webkit | 106.2 MB | **not implemented** | — | **not implemented** |

Event JSON is highly repetitive (addresses, topics and hashes recur constantly), and the browsers
compress it. So a generation of 31,332 real logs occupies roughly **2 MB stored**, not the 17.7 MB
its JSON weighs.

The practical consequence is that quota is a non-problem at this scale and the browser's
two-transient-generations default is comfortable: it is single-digit megabytes. It only becomes
interesting for a history one to two orders of magnitude larger, and the ratio means the crossover is
much further out than payload size suggests.

## 3. `navigator.storage.estimate()` CANNOT size the cap, on three independent grounds

`maxGenerations` must be a CONFIGURED number, not one derived at runtime from available storage:

- **WebKit does not implement it.** Both `quota` and `usage` came back null. Any cap derived from it
  is a cap that does not exist on Safari.
- **`quota` varies four-fold across engines** (5.4 GB chromium against 1.6 GB firefox) and MOVES
  within one engine between runs (6.4 GB then 5.4 GB on chromium), because it is a fraction of free
  disk rather than a promise.
- **It did not reflect the ACTUAL quota in force.** With the origin quota overridden to 8 MB and
  writes genuinely failing, `estimate().quota` still reported 6.45 GB. Whatever the mechanism, a
  pre-flight check against that number would have concluded there was 6 GB of headroom moments before
  `QuotaExceededError`.

This corroborates `work/notes/findings/sqlite-in-the-browser.md`, which found `estimate()` quantised
and lagging (it reported MORE after a prune that dropped nothing) and used record counts instead.

## What this does NOT say

- Nothing about whether a quota failure is RECOVERABLE, only that it is atomic. What an application
  should do when it cannot write is a separate question, and the spec's answer — refuse loudly, name
  what to delete — is unaffected either way.
- The compression ratio is for EVENT payloads specifically. A state fold of different shape will
  compress differently; do not reuse 8x as a general constant.
- The forced-quota run is chromium only, because it is the only engine that can be told to have a
  small quota. The atomicity result is therefore established on one engine; IndexedDB transaction
  semantics are specified, so the expectation is that it holds everywhere, but it is not measured
  everywhere.
