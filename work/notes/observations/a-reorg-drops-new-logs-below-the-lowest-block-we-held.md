---
title: "A concluded reorg drops the new branch's logs BELOW the lowest block we held logs for"
slug: a-reorg-drops-new-logs-below-the-lowest-block-we-held
observed: 2026-09-05
source: 'noticed while building task:the-canonical-view-is-gated-and-rewinds-on-a-reorg, reading `generateStreamToAppend` in `packages/core/src/internal/engine/utils.ts` to work out how far back a rewind must reach. Not reproduced; read from the code.'
---

On a reorg, `generateStreamToAppend` sets `startingBlockForNewEvent = reorgBlock.number` and then keeps only incoming blocks with `block.number >= startingBlockForNewEvent`. `reorgBlock` comes from `unconfirmedBlocks`, which holds only EVENT-BEARING blocks, so if the chain actually forked below the lowest block we held logs for, any log the NEW branch carries in that gap is inside the re-fetched range, is dropped by that filter, and is never fetched again (the next range starts above it).

Not acted on here: it is an engine-side fetch/derive property, and the canonical view's rewind answers the lowest block the STREAM retracted, which is exactly `reorgBlock.number` and therefore already the best the stored stream can support.
