---
title: The CLI's bnReviver can throw on a perfectly good snapshot, because a context hash can look like a BigInt
type: observation
status: spotted
spotted: 2026-08-21
---

Noticed while building `processor-version-hash-cannot-silently-lie`, which had to work around it for its own new field. The workaround is in; the pre-existing case is NOT, because fixing it means changing the version-hash format, which would invalidate every deployment's persisted state at once.

## What was seen

`packages/ethereum-indexer-cli/src/utils/bn.ts`:

```ts
export function bnReviver(k: string, v: any): any {
	if (
		typeof v === 'string' &&
		(v.startsWith('-') ? !isNaN(parseInt(v.charAt(1))) : !isNaN(parseInt(v.charAt(0)))) &&
		v.charAt(v.length - 1) === 'n'
	) {
		return BigInt(v.slice(0, -1)); // <- UNGUARDED
	}
	return v;
}
```

The guard is "starts with a digit and ends with `n`", but the conversion is `BigInt()` on everything in between. `BigInt('1x9tbh')` throws a `SyntaxError`, and it throws *inside* `JSON.parse`, so `createFileKeepState.fetch` catches it at `packages/ethereum-indexer-cli/src/keepState.ts` and logs "snapshot is present but could not be parsed, treating as no snapshot". The snapshot was fine. The run cold-starts, and it cold-starts again every time, since the same value is rewritten on save.

Any string in the persisted `lastSync` can trip this. Two that plausibly can:

- **`context.processor`, the JS path's version hash**, is `` `${version}-${configHash}` ``. A version starting with a digit (`1.0.0`, the normal case) plus a `simple_hash` config digest ending in `n` hits it. `simple_hash` returns base36, so that last character is `n` about 1 in 36 times: roughly **2.8% of CONFIGURED processors**, decided at random by the config's content, permanent for that config.
- **`context.processor`, the SQL path's hash**, is `` `${version}-${entitiesHash}-${configHash}` ``, same shape and same exposure.
- An unconfigured processor ends in `-not-configured` and is safe. So is anything with a non-digit first character.

Measured, over 200k `simple_hash` outputs: **1.25%** of bare base36 digests are `starts-with-digit && ends-with-n`, and every one of them makes `bnReviver` throw. (`keepStateOnLocalStorage` has the same convention but wraps it in a `try/catch`, so there the same value is silently *kept as a string* rather than throwing; its failure mode is `"123n"`-shaped hashes becoming BigInts.)

## Why it matters

It is a silent, permanent cold-start for an unlucky config hash, which for the `stratagems-snapshots` CI path means re-indexing from scratch on every run while the snapshot on disk is perfectly readable. It is also invisible: the log line blames the snapshot.

## What was done about it here (and what was not)

The new `processorFingerprint` field (`packages/ethereum-indexer/src/utils/fingerprint.ts`) is tagged `fp-` precisely so it can never present as a BigInt literal, and `packages/ethereum-indexer/test/processorFingerprint.test.ts` pins that shape against a copy of this reviver. That closes the NEW field only.

The pre-existing exposure of `context.processor` is untouched on purpose: changing the version-hash format would change every hash, so every deployment would discard its state on upgrade. The fix belongs in the reviver, not in the hashes: make `bnReviver` require the body to be all digits (or wrap the `BigInt()` in a `try`), mirroring the tagged codec that `@ethereum-indexer/processor-sqlite`'s `sync.ts` already argues for on exactly these grounds ("a suffix convention has to guess").

## Update, 2026-08-21: fixed, once the invalidation constraint was lifted

The maintainer confirmed there are effectively no users and that a version bump plus a move to `@ethereum/indexer` is coming, so invalidating existing state and changing hash formats is free. Both halves are now fixed in the same change as the task:

- **The guard.** There were SIX copies of the same unguarded reviver, not one: `ethereum-indexer-cli/src/utils/bn.ts`, `ethereum-indexer-browser`'s `OnIndexedDB` (the ADR-0002 primary path) and `OnLocalStorage`, `ethereum-indexer-fs/src/utils/json.ts`, `ethereum-indexer-db-utils/src/utils.ts`, and a dead pair in `ethereum-indexer-js-processor/src/processor/history.ts`. The predicate now lives once, in `ethereum-indexer/src/utils/bigint.ts` as `isBigIntLiteral` (`/^-?\d+n$/`), and every live site uses it; the dead pair was deleted. This closes the CLI's `TODO share with db-utils`.
- **The digest.** A guard alone cannot save a digest of all digits ending in `n`: `8918n` genuinely IS the convention's shape, and `simple_hash` was found producing it during the sweep test. Such a digest came back from storage as a **BigInt**, so `processorHash === context.processor` compared a string to a BigInt and discarded good state. `simple_hash` now prefixes every digest with `h`, which makes the shape unreachable rather than unlikely, for `context.processor`, `context.config` and `context.source[].hash` alike.

Pinned by `ethereum-indexer/test/bigint.test.ts` (the guard, swept over the shapes it must survive), `ethereum-indexer/test/hash.test.ts` (no digest can read as a BigInt literal) and `ethereum-indexer-cli/test/bn.test.ts` (the snapshot round-trip that used to cold-start).

What is still NOT fixed, and is the real lesson: the suffix convention itself still cannot distinguish a genuine BigInt from a contract-emitted string that reads like one. `processor-sqlite`'s tagged `{__bigint__: "..."}` codec is the form that can, and the remaining adapters should move to it rather than to a better regex.
