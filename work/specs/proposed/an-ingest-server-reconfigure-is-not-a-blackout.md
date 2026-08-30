---
title: 'An ingest-server reconfigure is not a blackout'
slug: an-ingest-server-reconfigure-is-not-a-blackout
needsAnswers: true
---

> Launch snapshot, records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

> **SPLIT out of `a-reconfigure-is-not-an-outage` after four review rounds.** That spec twice tried
> to cover the server: first by asserting an operator story it had no mechanism for, then by
> EXCLUDING the server on the false premise that it has no processor. Both were wrong in the same
> way, from the same cause: the server was never opened. It has a real outage with a real mechanism,
> and it gets its own spec.

<!-- open-questions -->

## Open questions

1. **Does the server hold two generations, or does it refuse the reconfigure?** The browser answer
   (build a successor alongside, promote when ready) assumes something can hold two states at once.
   The server's state lives behind `RemoteSQL` and its stream is the ADR-0006 emission-stream table,
   which is a different storage model. Refusing a context change until an operator explicitly
   migrates may be the better answer here, and is certainly the smaller one.
2. **What does a reader see during the interim?** The server serves queries; the browser story
   (render the live state, marked) may not transfer, because a server's readers are other systems
   rather than a UI that can dim a panel.
3. **Is this even the right layer?** The clearing happens in `StreamBuilder`, which is core, not
   server. So the fix may belong in the core primitive both runtimes share rather than in
   `@etherfold/server`.

## Problem Statement

The ingest server hosts a processor and blanks it on a context change, with no story for what its
readers see meanwhile.

The facts, checked rather than assumed:

- `createServer` mounts a status API and an ingest API and knows only `RemoteSQL`. It does not
  construct an `EthereumIndexer`, which is what misled two earlier drafts.
- But it HOSTS a processor by injection: `ServerOptions.getIngestion` returns a `LogIngestion`, and
  the ingest routes obtain it per request. When it is absent the server answers 501 with a body that
  says exactly this: **"this server hosts no processor: pass getIngestion to createServer to accept
  logs"**.
- `StreamBuilder` holds an `EventProcessor` and calls **`processor.clear()`** whenever the persisted
  cursor carries a different source, config or processor version — on `/ingest` and on
  `/ingest/expected-from-block`.

So a server whose fetcher's source or processor changed discards its state and rebuilds from the
feed, while continuing to answer queries from whatever it has. That is the same failure the browser
spec addresses, in a runtime with different storage, different readers and no UI.

## Solution

Undecided, deliberately: see the open questions. What this spec fixes NOW is that the problem is
named, located and owned, rather than being alternately over-claimed and wrongly excluded by a spec
about a different runtime.

The candidate shapes, in increasing order of cost:

1. **Refuse and require an explicit migration.** The server rejects a feed whose context differs
   until an operator acts. Smallest, safest, and arguably right for a system whose readers are other
   systems: a silent rebuild is worse than a loud refusal.
2. **Two lineages of the emission-stream table**, with the canonical view switched on promotion. This
   is the ADR-0006-shaped answer and the one the earlier drafts gestured at. It is real work, and
   ADR-0006's own docstring notes the emission-stream storage is not yet built.
3. **The full generation model**, matching the browser. Only worth it if the storage question above
   is answered anyway.

## User Stories

1. As an operator, I want a feed whose context changed to be handled deliberately rather than by a
   silent `processor.clear()`.
2. As an operator, I want to know that my server is rebuilding, rather than inferring it from a
   query returning less than it did a minute ago.
3. As a consumer of the server's API, I want a rebuild in progress to be distinguishable from an
   empty result, which is the same absence-versus-contradiction distinction the reorg model and
   `SuspectedTruncationError` already make.

## Implementation Decisions

**None yet, and that is honest.** The open questions above are genuine policy decisions about a
runtime whose storage model this spec has not yet examined in the depth the browser one received.
Writing decisions before that examination is what produced four rounds of corrections on the sibling
spec.

What IS decided: this is not the browser spec's problem, and the browser spec must not claim it.

## Out of Scope

- **The browser runtime**, which is `a-reconfigure-is-not-an-outage`.
- **The stream storage change**, which is `appending-to-the-stream-costs-the-batch` and applies to
  the client-side cache, not the server's table.

## Further Notes

The reason this exists as a stub rather than a full spec is worth recording. Two earlier drafts of
the browser spec each made a confident claim about the server: one promised an operator story with no
delivering mechanism, the other excluded the server for a reason that was factually false. Both came
from reasoning about a runtime rather than reading it. A stub that names the problem and admits what
is unknown is more useful than a third confident guess.
