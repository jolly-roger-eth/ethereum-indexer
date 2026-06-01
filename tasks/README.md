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

## Layout

There is no hand-maintained index of tasks here (it just goes stale) — list the folders instead:

- **Active tasks:** `ls tasks/` (the `*.md` files at the top level).
- **Done tasks:** `ls tasks/archive/` — each archived file keeps its own `**Status:**`/outcome note.
- **Findings:** `ls tasks/findings/` — review output, fed into the design/plan tasks.

A task's location IS its status: top-level = open, `archive/` = done. Open any file to read its
context + **Prompt** section.
