# What a snapshot costs, on the real workload

The measurement behind ADR-0028's answer to "what goes IN a snapshot": current rows only, or rows plus version history. Produced by `measure-snapshot-size.ts` in this folder; the raw output is `results/snapshot-size.json`.

Reproduce it (about a second):

```
pnpm --filter @etherfold/conformance-workload-stratagems exec \
  tsx ../../docs/spikes/bootstrap-an-entity-store-from-a-snapshot/measure-snapshot-size.ts
```

## The workload

The committed conformance workload, which is the LAUNCHED stratagems game on Base (`@etherfold/conformance-workload-stratagems`, `deployments/alpha1`): 31,332 events in 1,042 event-bearing blocks, blocks 12,082,307 to 23,303,136, replayed through the ported entity processor into a `MemoryStateStore`. It ends at **4,046 live rows** over **24,759 versions**, so history is roughly **6.1x** the current state.

Those two numbers are slightly below the ones in `work/notes/findings/sqlite-in-the-browser.md` (4,072 live rows, 29,393 versions), and the difference is the port improving rather than the measurement disagreeing: the spike's port modelled the ordered placement window as three entities plus a hand-maintained CSV index and a count, and the promoted port derives that collection from a bounded id-prefix listing instead (ADR-0021). Fewer helper rows, and fewer parent versions opened by every child write.

## The numbers

| what a client downloads | raw JSON | gzipped | against the gzipped stream |
| --- | --: | --: | --: |
| snapshot of **current rows** | 833.1 KB | **45.6 KB** | 0.07x |
| snapshot of **every version** (a ceiling) | 5,390.3 KB | **304.6 KB** | 0.49x |
| the captured event stream | 15,850.4 KB | **619.6 KB** | 1.00x |

The middle row is a CEILING rather than a proposal. No such envelope exists, because the seam has no way to install a version range: a version is what applying a block PRODUCES, and a write surface that could set `_lower` and `_upper` directly could manufacture states no sequence of blocks could reach. It is measured in the same encoding as the current-rows snapshot so the comparison is between like and like.

## What it decides

**Current rows.** The spread is not marginal:

- A current-rows snapshot is **7% of the gzipped stream**. That is the whole point of bootstrapping: 45.6 KB against 619.6 KB of stream, and against the RPC round trips and the replay of 31,332 logs that the stream still costs after it is downloaded.
- A full-history snapshot is **49% of the gzipped stream** and **6.7x the current-rows snapshot**. Half the bytes of the thing the history could be derived from, to avoid deriving it. A client that will pay 305 KB is most of the way to paying 620 KB for the stream, which it can replay into a store that then has real, verifiable history instead of somebody else's.

So the honest split is: a snapshot buys you the TIP cheaply, and history is what replaying the stream buys you. Carrying history in the snapshot lands between the two and is the worse deal at both ends.

The consequence a consumer must live with is exactly what ADR-0028 is about: a store bootstrapped from current rows has no history below the snapshot's block and must say so, rather than inheriting the `unbounded` a fresh store reports.
