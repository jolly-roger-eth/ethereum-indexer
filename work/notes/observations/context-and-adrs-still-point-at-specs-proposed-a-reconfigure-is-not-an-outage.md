# Dead in-repo references around the reconfigure spec

2026-09-03, spotted while building `the-invalidation-verdict-becomes-a-published-answer`.

`a-reconfigure-is-not-an-outage.md` moved to `work/specs/tasked/` in the tasking commit, but `CONTEXT.md` (lines 13 and 45), `docs/adr/0008`, `docs/adr/0033`, both `docs/spikes/*/README.md` and `work/notes/ideas/stream-grafting-what-we-established.md` still cite it under `work/specs/proposed/`. Same shape for `work/specs/proposed/the-server-and-cli-hold-generations-too.md` in ADR-0008. Separately, `InvalidationVerdict`'s JSDoc (`packages/core/src/internal/engine/utils.ts`) points at `work/notes/ideas/a-stream-branches-instead-of-being-discarded.md`, which does not exist in `work/notes/ideas/`.

Not fixed here: out of this task's scope, and a status-folder move breaking every citation of a spec looks like a general problem rather than a handful of typos.
