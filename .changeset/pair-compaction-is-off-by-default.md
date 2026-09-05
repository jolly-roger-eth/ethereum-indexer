---
'@etherfold/server': minor
---

Optional PAIR-COMPACTION over the stored emission stream: a retracted entry reclaimed TOGETHER WITH its retraction, far below finality, OFF BY DEFAULT (ADR-0006). New exports: `compactEmissionPairs`, `resolvePairCompaction`, `COMPACTION_OFF`, `DEFAULT_MAX_PAIRS`, and the `PairCompactionSetting` / `PairCompaction` / `PairCompactionOptions` / `PairCompactionQuery` / `PairCompactionReport` types.

```ts
import {compactEmissionPairs, resolvePairCompaction} from '@etherfold/server';

// at startup, so a bad depth is a boot failure and not a 3am surprise
resolvePairCompaction({blocks: 50_000}, {finality: 64});

// on whatever cadence THIS host wants
const report = await compactEmissionPairs(db, {
	indexer: 'alpha',
	stream: ingestion.streamDigest,
	compaction: {blocks: 50_000},
	finality: 64,
	latestBlock: tip,
});
// {floor: tip - 50_000, pairsCompacted: 12, rowsDeleted: 24, scanned: 24, complete: true}
```

**It is safe because it is ANSWER-PRESERVING for the canonical view by construction**, and that is asserted rather than claimed: it only ever removes rows that are already `alive = 0`, which that view already excludes, so `GET /{indexer}/canonical` returns a BYTE-IDENTICAL response over the same gate before and after a compaction. The only consumer that can observe it is one following the `seq` stream further behind than finality, which is already outside the window it may rely on. A from-genesis replay is unaffected too: an apply/retract pair has no net effect on a reducer whose revert is exact.

**The depth is BLOCK NUMBERS and no other unit, with the finality depth as its FLOOR** (ADR-0019, the same rule retention lives under). `{blocks: N}` or `'off'`; a duration, a count or a bare number is refused naming the one unit there is, because time would compact on wall-clock progress rather than chain progress. A depth that would compact at or above `latestBlock - finality` is **REFUSED naming both numbers and never clamped** to the floor: inside that window a retraction can still arrive, and a silent correction would leave an operator believing something untrue about the deployment. A depth exactly AT the floor is legal, and compacts strictly below it.

**Compaction is a call the HOST SCHEDULES** (ADR-0022), wired to no route and no timer: off-by-default is nobody calling it, not a flag this package reads. Appending never compacts, because the cost is proportional to what it drops and a browser tab, a backfilling CLI and a long-running server want three different cadences. **One call does bounded work**: it reads at most `maxPairs * 2` candidate rows and deletes at most `maxPairs` pairs, naming every row by its `seq` in statements chunked to 100 bound parameters (D1's cap), inside one batch. `complete` says whether the scan reached the end, so an amortised policy and a whole sweep are both expressible without the store inventing a cadence.

**A pair goes together or not at all.** A pair is one dead application (`removed = 0, alive = 0`) and one retraction (`removed = 1`) of the same `(blockNumber, blockHash, logIndex)`; both `seq` values are named in one statement inside one batch, an unmatched row is left alone, and a LIVE row is never a candidate however old. `seq` is never renumbered: compaction leaves HOLES, which are legal by contract and which both feed cursors already tolerate.
