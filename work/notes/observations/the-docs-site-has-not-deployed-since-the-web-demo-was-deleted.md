---
title: 'The docs site has not deployed since `examples/web-demo` was deleted: the Pages workflow still copies a `dist/` from a package with zero tracked files'
slug: the-docs-site-has-not-deployed-since-the-web-demo-was-deleted
observed: 2026-09-04
source: 'noticed while pushing three commits to main and checking CI: the "Deploy VitePress site to Pages" workflow failed, and it turned out to have failed on every one of the last 20 runs, including commits that changed nothing near docs'
---

`.github/workflows/docs.yml` builds the docs site and, before running VitePress, does:

```yaml
# The docs embed the demo at /examples. The demo imports the example
# processors, so all of examples/* has to be built, not just the demo.
- name: Build examples
  run: pnpm build:examples

- name: Copy demo in docs
  run: cp -R examples/web-demo/dist docs/public/examples
```

`examples/web-demo` **has zero tracked files.** It was deleted in `bb86a77` (2026-09-02, `retire-the-js-object-processor-path`, PR #37), which removed 39 files and 2802 lines including its `package.json`, `vite.config.ts` and all of `src/`. The workflow step that consumes its build output was not removed with it, so every run since fails at `Copy demo in docs` with:

```
cp: cannot stat 'examples/web-demo/dist': No such file or directory
```

The `Deploy` job depends on `build` and is therefore SKIPPED, not failed, which is why this is quiet: nothing half-publishes, the site simply stops updating. **The published documentation has been frozen since 2026-09-02** while `main` has taken many commits that touch `docs/` (ADR-0049 landed in that window, for one). The last 20 runs of this workflow are 20 failures, so the ratio is not a flake to re-run.

**The trap that hides it locally.** `ls examples/web-demo` still shows a directory here, containing `dist/` and `node_modules/`. Both are gitignored leftovers from before the deletion, so a local check "confirms" the path exists while a fresh CI checkout has nothing. Anyone diagnosing this from a working tree that predates PR #37 will conclude the workflow is fine. Check with `git ls-files examples/web-demo` (0 results), not with `ls`.

Also worth noting because it widens the blast radius slightly: `pnpm build:examples` is `pnpm --filter './examples/*' build`, and the workflow comment explains the demo imports the example processors. So the intent of these two steps was an embedded, runnable demo at `/examples` on the docs site, and that intent died with the package. The docs still reference an examples path in `docs/guide/indexing-in-a-browser-app/` and `docs/api/`, so whether those links currently point at anything real should be checked as part of whatever fix is chosen.

Three fix shapes, none decided here, because the choice is about what the docs site should OFFER and that is not a builder's call:

1. **Drop the demo.** Delete both steps and any `/examples` embed the docs still advertise. Smallest, and honest if the retirement of the JS-object processor path meant the demo was intentionally retired too.
2. **Re-point at a surviving example.** `examples/browser-reference` exists and is the obvious candidate for what the demo was showing. This keeps the docs' promise but needs someone to confirm that example builds to a servable `dist` and is actually what should be demoed.
3. **Make the copy conditional** (`if [ -d … ]`). Cheapest to green the workflow and the worst of the three: it converts a loud, correct failure into a silently missing demo, and the docs would keep linking to a page that is not there.

Option 1 or 2 depending on whether the demo is wanted; option 3 only as a deliberate stopgap with a follow-up. Not fixed here: it is a deployment/product question about the docs site, and it was found while pushing unrelated work.
