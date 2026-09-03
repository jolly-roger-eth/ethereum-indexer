---
'@etherfold/core': patch
---

A FOLLOWER now notices a retraction the writer it follows appended while PAUSED, instead of silently keeping a branch the chain abandoned.

A follower (a generation on a SHARED stream, ADR-0044) decided there was nothing to follow by comparing the stored stream's cursor against its own (`lastSyncStored.lastToBlock <= current.lastToBlock`). That is sound for a RUNNING writer, whose `lastToBlock` rises with the tip on every cycle, and WRONG for a paused one: a pause caps `toBlock` at the cursor it paused on (ADR-0045), so a reorg the writer detects at or below the cap during its drain is appended to the stream — retraction and replacement both — while `lastToBlock` never moves. A follower level with the cap took the early return and never replayed either, so its state stopped being a fold of the stream it claims to fold, and nothing reported it.

The follow path now asks the question of the STREAM instead of a summary of it: a follower remembers the emissions it last folded over the range it resumes from (block hash, index in the block, application or retraction) and does nothing only while what the stream holds there is emission-for-emission the same list. The stored cursor still contributes the half it cannot be wrong about — a stream reaching past this fold is new by definition. An idle follower therefore still re-walks nothing and re-delivers nothing, and a follower still issues zero `eth_getLogs`, writes zero segments and clears nothing. See ADR-0049.

Nothing about PAUSE changes: the cap and the frozen `lastToBlock` are the drain's own termination condition, and a paused writer is behaving correctly. No public API changes; a follower simply lands where a from-scratch fold of its stream lands, which is what it always promised.
