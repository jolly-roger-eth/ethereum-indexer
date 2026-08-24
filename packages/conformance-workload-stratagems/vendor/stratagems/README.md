# Vendored stratagems source (GPL-3.0), and why it is here

Everything in this folder is copied from [github.com/wighawag/stratagems](https://github.com/wighawag/stratagems) at commit `3d5a0b3f46bcc0d8370643b8382f11f99f81df00` (2024-12-18), which is **GPL-3.0**, while this repository is MIT.

**This is fine and it is deliberate.** Both codebases are the same author's, and using stratagems here as an example and as a test fixture is exactly what it is for. The note exists only so the licence difference is VISIBLE to a reader who meets these files without that context, rather than discovering it later and having to work out whether it was an accident.

| File | Origin | Change |
| --- | --- | --- |
| `stratagems.ts` | `common/src/stratagems.ts` | four import lines re-pointed; body verbatim |
| `types.ts` | `common/src/types.ts` + `ContractSimpleCell` from `common/src/grid.ts` | only the types the indexing path touches |
| `constants.ts` | `common/src/constants.ts` | verbatim |
| `js-processor.ts` | `indexer/src/index.ts` | imports re-pointed, generated `contracts` module replaced by `abi.ts`, `__VERSION_HASH__` placeholder replaced by a literal; every handler body verbatim |
| `abi.ts` | `contracts/deployments/base/{Stratagems,Gems,GemsGenerator}.json` (+ three events from `deployments/alpha1/GemsGenerator.json`) | generated |

**Where this came from, and what runs it.** These files were vendored by `docs/spikes/sqlite-in-the-browser` and PROMOTED here with it, because they are the equality oracle of the conformance workload rather than evidence for a finished measurement. `src/oracle.ts` drives `js-processor.ts` over the committed streams through `@etherfold/core`'s own replay path; `test/oracle.test.ts` asserts it still reproduces the committed golden state, so this folder is executed rather than merely stored.

**Why copied rather than imported.** A spike that only runs while a sibling checkout happens to exist at a particular path is not re-runnable, and the equality oracle has to be the same bytes that computed the state being compared against, not a paraphrase of them.

**The three alpha1 events.** `AccounFixedRewardUpdated`, `AccountSharedRewardUpdated` and `GlobalRewardUpdated` do not exist on the `deployments/base` `GemsGenerator`, which is an earlier version of the contract. They are in `abi.ts` so the three handlers that consume them stay verbatim and the port covers all thirteen handlers. On the `stratagems-base` fixture they can never fire; on `stratagems-alpha1`, the LAUNCHED game, they are 16,046 of the 31,332 events. See `../../fixtures/README.md` for why `base` is not "the Base deployment".
