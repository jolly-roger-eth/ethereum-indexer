---
title: Trigger system (act on log & state conditions)
slug: trigger-system
---

> **DROPPED, on a deliberate product decision: the trigger system is a SEPARATE DELIVERABLE and is
> not built in this repo.** It is not dropped as a bad idea, and nothing about the need has changed.
> ADR-0005 already decided the shape (triggers run in independent consumer services, each owning its
> cursor, gate, outbox, webhooks and auth; the indexer-server holds no trigger state), and the
> remaining ADRs — 0007 lanes, 0009 actions, 0011 rate bounding, 0012 lifecycle, 0013 conditions —
> are the durable record. All seven user stories below belong to that other deliverable.
>
> **WHAT THIS REPO STILL OWES IT is the point of keeping this file**, and it is small and already
> owned: a FEED, and HISTORIC QUERY. The consumer contract is written out below so a platform change
> can be checked against it rather than against memory. `work/specs/proposed/indexer-server-feed.md`
> carries the feed half and `work/specs/tasked/historical-state-database.md` the query half; two
> genuine gaps found while writing this contract are recorded in that feed spec's Implementation
> Decisions rather than left here.
>
> Dropped rather than kept as an exploration spec because its only local output would have been a
> design doc that six ADRs now largely contain. `work/specs/dropped/` is reachable from `ready/` and
> this spec was never tasked, so the move is legal (WORK-CONTRACT, the spec lifecycle).

## The consumer contract this platform owes an external trigger service

Each line is a requirement the trigger service has, and the spec that owns it here. This is the list
to re-check when the feed or the state store changes; it is NOT a list of things to build now.

| What a trigger service needs | Owned by | State |
| --- | --- | --- |
| An ordered feed it can resume from a cursor IT controls | `indexer-server-feed` story 1 | owned |
| A retraction-aware stream with a monotonic `seq`, for the `fast` lane that cancels before firing | `indexer-server-feed` story 2 | owned |
| A canonical gated view with no retractions in it, for the `safe` lane | `indexer-server-feed` story 3 | owned |
| Its cursor validated against the block hash it last saw, so a reorg says REWIND rather than silently skipping | `indexer-server-feed` story 4 | owned |
| Cursor semantics that tolerate `seq` HOLES, so compaction cannot break it later | `indexer-server-feed` stories 5 and 7 | owned |
| State read AS OF the triggering log's block, never at the tip | `historical-state-database` stories 1-3 | owned, and SHIPPED (`StateStore.getAsOf`) |
| An `eth_getLogs`-shaped read, if it wants one | `node-log-api` | owned, gated |

**Two gaps this contract exposed, both now recorded in `indexer-server-feed`'s Implementation
Decisions rather than left implicit here:**

- **Retention bounds how far a consumer may lag.** A state condition is evaluated as of the
  triggering log's block, and ADR-0019 makes an as-of read outside the retention window a
  `BlockNotRetainedError` — a refusal, not an answer — while ADR-0028 gives a bootstrapped store a
  floor at its snapshot. So a trigger service that falls far enough behind cannot evaluate its
  predicate AT ALL. That is the correct refusal rather than a bug (a plausible wrong answer would be
  worse), but it is a DEPLOYMENT CONSTRAINT nobody had written down: retention must exceed the worst
  lag the trigger service is allowed to accumulate.
- ~~**Which generation does the feed serve, and does a consumer's cursor survive a promotion?**~~
  **ANSWERED, and it is the one platform change this contract produced.** The feed serves the
  CANONICAL generation and ADVERTISES the generation identity it answered from; what a consumer does
  when that identity changes is the CONSUMER's decision, not the platform's. The expected trigger-
  service behaviour is to PAUSE and let its operator decide, because a notifier that already fired
  cannot unfire and only the service knows that. Recorded in `indexer-server-feed`'s Implementation
  Decisions; `node-log-api` answers its own surface the same way.

> **PARTLY SUPERSEDED. Read `docs/adr/0005`, `docs/adr/0006` and `docs/adr/0007` first.**
>
> - **Open question 5 is answered NO (ADR-0005).** Triggers do **not** evaluate in the processor. They run in independent consumer services, each owning its cursor, gate, outbox, webhooks and auth. The indexer-server holds no trigger state at all.
> - **Open question 4 relocates (ADR-0005).** The durable queue is a transactional outbox in *each consumer's own* database, pairing that consumer's cursor advance with its delivery rows. A managed queue is transport, never the source of truth.
> - **Open question 3 is answered (ADR-0007).** Consumers gate themselves in a `safe` or `fast` lane. `fast` reads the retraction-aware stream and cancels before firing; `safe` reads the canonical gated view. The feed is at-least-once, so actions need **semantic** idempotency keys.
> - **Consequence for user stories 3, 4, 6 and 7:** these are now requirements of the reference *trigger service*, not of the platform. The platform guarantees the feed (ordered, resumable, no silent loss), not the delivery.
>
> - **Open question 1 is answered (ADR-0013).** Conditions are declarative data referencing operator-deployed code: a matcher over a log's **decoded** arguments (topics are only a fast path, since the argument a trigger cares about is often not indexed), plus a *named* state predicate parameterised by the registration. No bespoke DSL, and user-supplied code is never executed.
> - **Open question 6 is partly answered.** Registration proves address ownership via a registered/delegated signer, sharing one implementation with `push-notification`'s `/register`; recipient identity is `(address, domain)`, already decided by that service. Payload signing and per-target webhook validation for non-push actions remain open. Abuse control is ADR-0011 (rate-based) and lifecycle is ADR-0012.
>
> Also decided since: the action primitive and delivery policy (ADR-0009), cost bounding and digests (ADR-0011), trigger lifecycle (ADR-0012).
>
> ~~Unchanged: a state condition is still evaluated as of the triggering log's block, so the historical-state database still lands first. Open question 2 is unchanged.~~ **This line is itself now stale**, which is why the question list below was rewritten rather than patched: the design it was waiting on LANDED (`docs/design/historical-state-database.md`, its spec is in `work/specs/tasked/`, and `StateStore.getAsOf` is shipped). A state condition is still evaluated as of the triggering log's block; what is NEW is that the read can be REFUSED, per ADR-0019 retention — see the rewritten open question 4.

<!-- open-questions -->
<!--
  TRANSIENT BLOCK — stripped by the apply rung on full resolution.
  This is a DESIGN task (produce the design doc); its open questions ARE the design
  decisions. Flagged needsAnswers + taskedAfter historical-state-database, since a state
  condition depends on the historical-state query API. Clear the flag + delete this block
  once the design doc lands.
-->

## Open questions

REWRITTEN after an audit against what has landed. The old list is retired because five of its six
items were answered by ADRs while the questions themselves sat unchanged, which is worse than no
list: a reader could not tell which were live. Retired, with where each went, so nothing is silently
dropped: **1** answered by ADR-0013 (conditions are declarative data referencing operator-deployed
code; no DSL, no user code executed); **2** answered — the as-of-block read it was waiting on SHIPPED
(`StateStore.getAsOf`, and `docs/design/historical-state-database.md` landed), so the banner's claim
that it is "unchanged" is itself stale; **3** answered by ADR-0007 (`safe`/`fast` lanes, at-least-once,
semantic idempotency keys); **4** relocated by ADR-0005 (a transactional outbox in each consumer's own
database); **5** answered NO by ADR-0005 and now MEANINGLESS as phrased, since it asks to confirm a
placement that no longer exists; **6** partly answered (registration proves address ownership via a
registered/delegated signer, abuse control is ADR-0011, lifecycle is ADR-0012).

What is genuinely live:

1. **IS THIS REPO THE HOME FOR THIS AT ALL?** The one that gates the others, and a product decision
   rather than a technical one. Under ADR-0005 triggers run in independent consumer services and the
   indexer-server holds no trigger state; the banner already concedes stories 3, 4, 6 and 7 to the
   reference trigger SERVICE, and 1, 2 and 5 follow it for the same reason (registration, condition
   evaluation and reorg-firing all live there too, per ADR-0013 and ADR-0007). What this repo owes is
   the FEED (`indexer-server-feed`) and the as-of-block query API (`historical-state-database`), and
   both are owned by other specs and one is already tasked. ADR-0009 and ADR-0012 already record
   integration findings against another repo. So on the evidence ALL SEVEN user stories below belong
   to a different deliverable, and the only thing left here is this spec's own stated output, the
   design doc — which six ADRs now largely contain. Three honest dispositions: keep it as an
   EXPLORATION spec whose done is `docs/design/trigger-system.md`; move it to the repo that will
   build it; or DROP it and let the ADRs stand as the record. This cannot be settled by reading code.
2. **Payload signing** for non-push actions: what signs, what is signed, and how a target verifies.
3. **Per-target webhook validation** for non-push actions (the push path's `(address, domain)`
   recipient identity is already decided by the push-notification service).
4. **A retention constraint nobody has recorded, and it may invalidate story 2.** ADR-0019 makes an
   as-of read outside the retention window a `BlockNotRetainedError` — a refusal, not an answer — and
   ADR-0028 gives a bootstrapped store a floor at its snapshot. A state condition is evaluated AS OF
   THE TRIGGERING LOG'S BLOCK, so a consumer that has fallen behind the retention window cannot
   evaluate its predicate AT ALL: the platform refuses. Neither the spec nor the banner knows this.
   Does the trigger service pin a minimum retention on the indexer it reads, fire on a degraded
   basis, or refuse the registration up front?

<!-- /open-questions -->

## Problem Statement

The maintainer wants a system that fires an action when a condition based on **logs and/or state** is met — the primary use case being **push notifications**. Triggers must be **reliable**: it must be possible to guarantee the action actually runs. (Per ADR-0005 that guarantee is the reference trigger SERVICE's, not this platform's: what this repo guarantees is the FEED — ordered, resumable, no silent loss — and never the delivery.)

Critical constraint: a **state condition cannot be read naively at trigger time**, because by the time the condition is evaluated the state may have already advanced to a newer block. The condition must read state **as of the block of the triggering log** — which is why this depends on the historical-state database.

## Solution

> **The paragraph below is SUPERSEDED by ADR-0005 and is kept only so the change is visible.** It
> says triggers are evaluated IN the log-processor. They are not: they run in independent consumer
> services, each owning its cursor, gate, outbox, webhooks and auth, and the indexer-server holds no
> trigger state at all. A tasker reads the Solution, so leaving it uncorrected was the live hazard
> here — the banner corrected only the open question.

A trigger mechanism, running in an independent CONSUMER service that follows this repo's feed, that:
matches log conditions and as-of-block state predicates; enqueues matched actions onto a durable
queue (a transactional outbox in that consumer's OWN database, pairing its cursor advance with its
delivery rows) with retries / at-least-once delivery / idempotency; and delivers via an extensible
action interface (HTTP webhook first, extensible to push providers).

~~A trigger mechanism, evaluated in the **log-processor** (which has the events, the DB, and historical state), that: matches log conditions and as-of-block state predicates; enqueues matched actions onto a **durable queue** with retries / at-least-once delivery / idempotency; and delivers via an extensible action interface (HTTP webhook first, extensible to push providers, possibly via a third-party handler).~~

## User Stories

1. As a consumer, I want to register a trigger on a **log condition** (event name, contract address, indexed-arg filters), so that an action fires when that event occurs.
2. As a consumer, I want to register a trigger on a **state condition** evaluated **as of the triggering log's block**, so that the predicate sees the correct historical state, not a later one.
3. As a consumer, I want the first action type to be an **HTTP webhook**, with an extensible interface for other types (e.g. push provider), so that I can grow delivery channels.
4. As a consumer, I want triggers delivered **reliably** (durable queue, retries, dead-letter, idempotency keys), so that an action is guaranteed and retries never double-send.
5. As a consumer, I want defined **reorg behaviour** (fire-on-final, or fire-optimistically-with-retraction), so that a trigger on a reorged-out block is compensated.
6. As a consumer, I want to **observe delivery status / failures** for my registered triggers, so that I can detect and react to problems.
7. As an operator, I want webhook targets **authenticated and payloads signed**, so that the delivery path cannot be abused.

## Implementation Decisions

- **Hard dependency:** the historical-state database (`historical-state-database` spec) — its as-of-block query API is what state conditions consume. That design has since LANDED (`docs/design/historical-state-database.md`, and `StateStore.getAsOf` is shipped code), so the dependency is satisfied rather than pending; see open question 4 for the retention limit it comes with.
- Triggers evaluate in an independent CONSUMER service, never in the processor (ADR-0005); the durable queue is that consumer's own transactional outbox, with a managed queue as transport and never as the source of truth.
- Relevant existing surface: the reorg model in the core engine, and the `LogEvent` / `LastSync` types. **NOT `ethereum-indexer-server`** — that package has no source left (only build output), ADR-0010 puts it on the retirement path and ADR-0017 renamed the project. The live server is `packages/server`, hosting the stream-builder.

> Trimmed at tasking-time.

## Testing Decisions

- Test as-of-block condition evaluation against the historical-state store (correct block's state read).
- Test delivery guarantees: retries + idempotency (no double-send), reorg retraction where applicable.

## Out of Scope

- Implementation. First output is the DESIGN DOCUMENT (`docs/design/trigger-system.md`), ideally after (or alongside) the historical-state DB design.

## Further Notes

- Supersedes the old ad-hoc plan `tasks/plan-trigger-system.md`.
- The former `ethereum-indexer-streams` package (un-started multi-source server skeleton) was removed; its concept is superseded by the log-watcher / log-processor split in the historical-state spec.
