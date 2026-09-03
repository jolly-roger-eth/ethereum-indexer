---
title: "The CLI's `--rps` is typed as a `number` and commander hands it over as a `string`"
slug: cli-rps-is-typed-as-a-number-and-arrives-as-a-string
observed: 2026-09-03
source: 'spotted while renaming the one-shot to `etherfold build` (the-one-shot-is-build-and-serve-is-only-the-read-tier)'
---

`Options.rps` is declared `rps?: number` (`packages/cli/src/types.ts`) but `--rps <value>` is registered with no `parseFloat` argument (`packages/cli/src/program.ts`), so commander delivers the string `'5'`, which `resolveIndexOptions` passes straight into `JSONRPCHTTPProvider`'s `requestsPerSecond`. Nothing has complained, so the provider is presumably coercing it, but the type is a lie and a `String`/`number` comparison there would be the silent kind of wrong. Not fixed: the rename task's fence is the command WORDS, and `one-configuration-path-for-every-command` owns the option-resolution path this belongs to.
