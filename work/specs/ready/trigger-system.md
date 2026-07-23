---
title: Trigger system (act on log & state conditions)
slug: trigger-system
needsAnswers: true
taskedAfter: [historical-state-database]
---

> Launch snapshot — records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

<!-- open-questions -->
<!--
  TRANSIENT BLOCK — stripped by the apply rung on full resolution.
  This is a DESIGN task (produce the design doc); its open questions ARE the design
  decisions. Flagged needsAnswers + taskedAfter historical-state-database, since a state
  condition depends on the historical-state query API. Clear the flag + delete this block
  once the design doc lands.
-->

## Open questions

1. Condition model: how are log conditions (event name, address, indexed-arg filters) and state predicates (as-of the log's block) expressed — config object / small DSL / processor hook?
2. Evaluation semantics: confirm the state condition reads state **as of the triggering log's block** (via the historical-state DB), avoiding the "state already advanced" timing bug.
3. Reorg behaviour: fire-on-unconfirmed vs. fire-on-final vs. hybrid (fire optimistically + retraction); exactly-once vs. at-least-once under reorgs.
4. Delivery/queue: durable queue design (retries, dead-letter, idempotency keys), mapped to serverless (Cloudflare Queues or external) + third-party push providers.
5. Where it runs: confirm triggers evaluate in the log-processor (it has events + historical state + DB).
6. Security: webhook target validation, payload signing, abuse prevention.

<!-- /open-questions -->

## Problem Statement

The maintainer wants a system that fires an action when a condition based on **logs and/or state** is met — the primary use case being **push notifications**. Triggers must be **reliable**: it must be possible to guarantee the action actually runs.

Critical constraint: a **state condition cannot be read naively at trigger time**, because by the time the condition is evaluated the state may have already advanced to a newer block. The condition must read state **as of the block of the triggering log** — which is why this depends on the historical-state database.

## Solution

A trigger mechanism, evaluated in the **log-processor** (which has the events, the DB, and historical state), that: matches log conditions and as-of-block state predicates; enqueues matched actions onto a **durable queue** with retries / at-least-once delivery / idempotency; and delivers via an extensible action interface (HTTP webhook first, extensible to push providers, possibly via a third-party handler).

## User Stories

1. As a consumer, I want to register a trigger on a **log condition** (event name, contract address, indexed-arg filters), so that an action fires when that event occurs.
2. As a consumer, I want to register a trigger on a **state condition** evaluated **as of the triggering log's block**, so that the predicate sees the correct historical state, not a later one.
3. As a consumer, I want the first action type to be an **HTTP webhook**, with an extensible interface for other types (e.g. push provider), so that I can grow delivery channels.
4. As a consumer, I want triggers delivered **reliably** (durable queue, retries, dead-letter, idempotency keys), so that an action is guaranteed and retries never double-send.
5. As a consumer, I want defined **reorg behaviour** (fire-on-final, or fire-optimistically-with-retraction), so that a trigger on a reorged-out block is compensated.
6. As a consumer, I want to **observe delivery status / failures** for my registered triggers, so that I can detect and react to problems.
7. As an operator, I want webhook targets **authenticated and payloads signed**, so that the delivery path cannot be abused.

## Implementation Decisions

- **Hard dependency:** the historical-state database (`historical-state-database` spec) — its as-of-block query API is what state conditions consume. That design lands first (hence `taskedAfter`).
- Triggers evaluate in the **log-processor** component (consistent with the historical-state architecture); the durable queue maps onto the serverless / Cloudflare direction (Cloudflare Queues or external) with third-party push providers acceptable for delivery.
- Relevant existing surface: the HTTP server layer (`ethereum-indexer-server`) and its auth/response TODOs (see `docs/reviews/todo-triage.md`); the reorg model in the core engine; `LogEvent`/`LastSync` types.

> Trimmed at tasking-time.

## Testing Decisions

- Test as-of-block condition evaluation against the historical-state store (correct block's state read).
- Test delivery guarantees: retries + idempotency (no double-send), reorg retraction where applicable.

## Out of Scope

- Implementation. First output is the DESIGN DOCUMENT (`docs/design/trigger-system.md`), ideally after (or alongside) the historical-state DB design.

## Further Notes

- Supersedes the old ad-hoc plan `tasks/plan-trigger-system.md`.
- The former `ethereum-indexer-streams` package (un-started multi-source server skeleton) was removed; its concept is superseded by the log-watcher / log-processor split in the historical-state spec.
