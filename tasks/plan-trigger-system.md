# Plan: Trigger system (act on log & state conditions)

**Area:** new mechanism / design
**Type:** Planning (produce a design document, not an implementation)
**Status:** todo
**Depends on:** historical-state database (see `plan-historical-state-database.md`) — see "Hard dependency" below.

## Context

The maintainer wants a system that can **trigger an action when a condition based on logs and/or
state is met**. Examples of triggered actions:

- an **HTTP call** (webhook),
- potentially other action types later.

A primary use case is **sending push notifications**.

Key requirement: triggers should be **reliable** — i.e. it must be possible to guarantee the action
is actually executed. That implies a **queue** (durable, with retries / at-least-once delivery)
rather than fire-and-forget, and it may be acceptable to use a **third-party handler** for the actual
delivery (e.g. a push-notification provider, or a managed queue/worker).

## Hard dependency: historical state

A **state condition** cannot be evaluated naively at trigger time, because of a timing problem:

> When a log occurs and the trigger logic wants to read "the state", the state may have **already been
> advanced** to a newer block by the time the condition is evaluated. Reading the *current* state would
> give the wrong answer for the block at which the log happened.

Therefore the trigger system **requires access to historical state** — the ability to read the state
**as of the specific block (hash/height) at which the triggering log occurred**. This ties directly
to `plan-historical-state-database.md`; that design should land first (or at least define the
historical-state query API the trigger system will consume).

Also relevant:
- Reorgs: a trigger fired on an unconfirmed block may need to be **cancelled/compensated** if that
  block is reorged out before finality. The design must address whether triggers fire on
  unconfirmed blocks (low latency, risk of false triggers) or only after finality (safe, higher
  latency), or a hybrid (fire optimistically + emit a retraction).
- Existing pieces: the reorg model in `packages/ethereum-indexer/src/internal/engine/utils.ts`, the
  `LogEvent` / `LastSync` types in `packages/ethereum-indexer/src/types.ts`, and (if it exists by then)
  the historical-state query API.
- The existing HTTP server layer (`packages/ethereum-indexer-server/src/server/simple.ts` and
  `packages/ethereum-indexer-streams/src/server/multiStreams.ts`) and its TODOs (auth / api key,
  response field shaping) — see `tasks/findings/todo-triage.md` ("Server / streams packages").
  Relevant to the trigger registration/delivery API surface.

## Goal of this task

Produce a **design document** (e.g. `docs/design/trigger-system.md`) — NOT an implementation —
covering:

1. **Condition model** — how a trigger condition is expressed. Cover:
   - **log conditions** (event name, contract address, indexed args/filters), and
   - **state conditions** (a predicate over the computed state *as of the log's block*).
   Propose a concrete, declarative way to define these (config object / small DSL / processor hook).
2. **Evaluation semantics & the historical-state requirement** — define exactly which block's state a
   condition reads (the block of the triggering log), and how that is obtained from the
   historical-state DB. Spell out the timing problem above and how the design avoids it.
3. **Reorg behaviour** — fire-on-unconfirmed vs. fire-on-final vs. hybrid (with retraction/compensation);
   exactly-once vs. at-least-once implications under reorgs.
4. **Action types** — start with HTTP webhook; define an extensible action interface so other types
   (e.g. push provider) can be added. Note where a third-party handler fits.
5. **Delivery guarantees & queue** — the durable queue design: enqueue on trigger, retry policy,
   dead-letter, idempotency keys (so retries don't double-send), and how this maps onto a serverless
   deployment (consistent with the log-processor / Cloudflare Worker direction — consider Cloudflare
   Queues or an external queue, and third-party push providers).
6. **Where it runs** — relationship to the log-watcher / log-processor split: triggers are most
   naturally evaluated in the **log-processor** (it has the events + historical state + DB). Confirm
   and detail.
7. **API / config surface** — how a consumer registers triggers, and how they observe
   delivery status / failures.
8. **Security** — authenticating/validating webhook targets, signing payloads, preventing abuse.
9. **Phased implementation plan** — smallest useful first version (e.g. log-only conditions + HTTP
   webhook + simple retry queue) before state-condition + push, plus a test strategy.

## Constraints / conventions

- Planning only — deliver a markdown design doc; do not implement.
- Should be done in a **fresh context**, ideally after (or alongside) the historical-state DB plan.

## Prompt (paste into a fresh context)

> I want to plan (design only — no implementation) a **trigger system** for the `ethereum-indexer`
> monorepo: a mechanism that fires an action when a condition based on **logs and/or state** is met.
> The first action type is an **HTTP webhook**, with an extensible interface for others (a key use
> case is **push notifications**, possibly via a third-party handler). Triggers must be **reliable** —
> guaranteed execution — which implies a **durable queue** with retries / at-least-once delivery and
> idempotency, not fire-and-forget.
>
> Critical constraint: **state conditions require historical state.** When a log occurs and the
> condition wants to read "the state", the state may already have advanced to a newer block, so the
> condition must read the state **as of the block of the triggering log** — i.e. it depends on the
> historical-state database design (see `tasks/plan-historical-state-database.md` /
> `docs/design/historical-state-database.md` if present). Assume triggers run in the **log-processor**
> component (which has the events, the DB, and historical state).
>
> Study the reorg model in `packages/ethereum-indexer/src/internal/engine/utils.ts` and the
> `LogEvent`/`LastSync` types in `packages/ethereum-indexer/src/types.ts`. Then produce a design
> document covering: the condition model (log conditions + state predicates as-of-block); evaluation
> semantics and how historical state is queried (spelling out the state-advanced-already timing
> problem); reorg behaviour (fire on unconfirmed vs. final vs. hybrid with retraction; exactly-once vs.
> at-least-once under reorgs); action types (HTTP first, extensible, third-party push handler);
> delivery guarantees & the durable queue (retries, dead-letter, idempotency keys, mapping to
> serverless / Cloudflare Queues or external queue); where it runs (log-processor); the registration/
> config API and delivery-status observability; security (webhook auth, payload signing); and a phased
> implementation plan with a test strategy. Deliver it as a markdown file under `docs/design/` and do
> not start implementing.
