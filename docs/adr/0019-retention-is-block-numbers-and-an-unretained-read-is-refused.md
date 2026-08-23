# Retention is measured in block numbers only, and a read outside it is refused

How far back a store keeps superseded versions is declared in **block numbers** and in no other unit: a deployment sets `'unbounded'`, `'revert-only'` or `{blocks: N}`, the finality depth is the floor, and an as-of read the store does not retain throws `BlockNotRetainedError` rather than answering. Durations and counts of updates are refused at the API, not merely discouraged. One unit means one enforcement path, one prune predicate, one capability report and one set of conformance cases.

## Why not a duration

Retention keyed on wall-clock time prunes on the wrong clock. An indexer stalled for a day would drop a day of history it never finished writing, and a halted chain would expire its entire window while its tip stands still. Retention must key on the thing that moves the tip, which is block numbers.

Time is not lost by this: on the READ side it is already solved, because a block address resolves a timestamp to the latest recorded block at or before it (ADR-0015). "State around time T" therefore needs no retention concept of its own.

## Why not a count of updates

It is derivable, so making it a second retention kind would duplicate the prune path, the report and the tests for something a caller can compute. Every backend already indexes the blocks that changed something, so "the last N updates" is one indexed lookup that yields a floor BLOCK NUMBER, above the seam, after which the ordinary block-number path does the rest. No resolver ships today (nothing asks for one yet); when it does, it returns a block number and nothing below the seam learns about it.

## The trap a default must not walk into

A window of N blocks is **not** N updates of history, and the naive reading is wrong by orders of magnitude on a sparse contract. On the real measured stream (the launched stratagems game on Base, `work/notes/findings/sqlite-in-the-browser.md`) event-bearing blocks are median **429 blocks apart**, so at a finality of 64 exactly ONE event-bearing block's history survives: the tip's. This is why the light backend's as-of capability was withdrawn by SPARSITY rather than by cost, and why the default retention is `unbounded` rather than any number that looks generous.

## Why the refusal is an error, and why it joins `NoSuchBlockError`

An as-of read served from the tip is a plausible wrong number that nothing downstream can tell apart from a true one, and `undefined` already means "that block is known and the entity was absent from it", which is an ordinary answer a caller acts on normally. So a read outside the retained window throws.

ADR-0015 settled the same argument for an unresolvable block address; a retention boundary is the second way a historical read can fail, so it is the same family rather than a new one: `BlockUnavailableError` is the base (defined at the seam, because every backend throws it and two classes of one name would break `instanceof` across packages), with `NoSuchBlockError` and `BlockNotRetainedError` as its members. The refusal carries the block that was requested and the range that is retained, so the error says what was asked and what is kept.

## Consequences

- **A store reports what it PROVIDES, never what it was asked for.** A store may claim a window only if it enforces one, and understating retention is the safe direction (a caller relies on less history than exists) while claiming a window nothing enforces is the exact failure the report exists to prevent. *Superseded in part by ADR-0022*: when this was written neither shipped store pruned, so a configured window was validated and then reported as `unbounded`. Both now enforce a window on both halves (refused on read, dropped from storage by `prune`), so both report it. The rule is unchanged; what changed is that it is now satisfiable.
- **`revert-only` is enforceable without pruning**, so it is honoured by any store set to it: every as-of read is refused and `revertTo` keeps working. That is how the refusal a patch-log backend will produce is exercised before that backend exists.
- **A window states the finality depth it protects**, and is refused below it naming both numbers. Reorg revert reopens versions closed after the fork point, so a window shorter than the finality depth is not a smaller store, it is a broken one. Because that depth is configured on the store while the depth a reorg actually reaches comes from the stream, `VersionedStateEventProcessor` reconciles the two at `load` and raises if the store's floor is shallower.
