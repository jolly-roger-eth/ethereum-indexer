# Tasks

Each file in this folder describes a self-contained piece of work. They are written so that
each can be picked up independently in a fresh context (a new chat / new agent session) without
needing the history of previous sessions.

Suggested workflow per task:

1. Open the task file.
2. Use its **Prompt** section as the opening message in a fresh context.
3. Follow the TDD approach used elsewhere in this repo (write a failing test first where the
   logic is testable, then fix, then verify), and keep commits small and reviewable.

## Conventions in this repo (context for any task)

- Monorepo managed with `pnpm` workspaces; packages under `packages/*`.
- Tests use **vitest**, located in each package's `test/` folder, run with `pnpm --filter <pkg> test`.
- Logging goes through **named-logs** (`import {logs} from 'named-logs'`), not `console.*`, in the
  core `ethereum-indexer` package.
- Changes that affect a published package's public API require a **changeset** (`.changeset/*.md`).
- Do NOT auto-commit, push, or run destructive commands without explicit confirmation.

## Findings

Review output is written to `tasks/findings/` so it can be fed into the design plans:

- [findings/revertable-database.md](./findings/revertable-database.md)
- [findings/event-cache.md](./findings/event-cache.md)
- [findings/ethereum-indexer-browser.md](./findings/ethereum-indexer-browser.md)
- [findings/todo-triage.md](./findings/todo-triage.md) — triage of the ~60 existing inline TODOs + root `TODO.md`

## Active tasks

| Task | Area | Type | Status |
|------|------|------|--------|
| [plan-historical-state-database.md](./plan-historical-state-database.md) | new server-side arch (log-watcher + log-processor) / design | Planning | todo |
| [plan-trigger-system.md](./plan-trigger-system.md) | new mechanism (depends on historical state) / design | Planning | todo |
| [modernize-repo.md](./modernize-repo.md) | repo-wide tooling / config | Implementation (maintainer) | todo |

## Archived (done)

Completed tasks are moved to `tasks/archive/`. Their findings remain under `tasks/findings/`.

| Task | Area | Type | Outcome |
|------|------|------|---------|
| [archive/review-revertable-database.md](./archive/review-revertable-database.md) | `ethereum-indexer-db-processors` | Review | done (initial) — see [findings](./findings/revertable-database.md) |
| [archive/review-event-cache.md](./archive/review-event-cache.md) | `ethereum-indexer-db-utils` | Review | done (initial) — see [findings](./findings/event-cache.md) |
| [archive/review-ethereum-indexer-browser.md](./archive/review-ethereum-indexer-browser.md) | `ethereum-indexer-browser` | Review | done (initial) — see [findings](./findings/ethereum-indexer-browser.md) |
