---
title: 'The processor fingerprint is blind to closure state, so a factory-built processor has a constant fingerprint whatever it captures'
slug: the-processor-fingerprint-is-blind-to-closure-state
source: 'found by probing whether rebuild-on-drift is expressible today (the design conversation behind work/notes/ideas/what-invalidates-computed-state.md). Reproduced at etherfold 60b0dd6 against `fromJSProcessor` + `keepStateOnIndexedDB` under fake-indexeddb; the mechanism is read from `processorCodeFingerprint` and decision 5 of work/tasks/done/processor-version-hash-cannot-silently-lie.md.'
---

`getCodeFingerprint()` hashes the SOURCE TEXT of the author's handlers, read through property descriptors and normalised for whitespace. Source text is all it can see, so a handler whose behaviour is decided by a **closure-captured value** fingerprints identically no matter what that value is.

Measured, with two processors built by the same factory at different arguments:

```ts
function proc(countBy: number): JSProcessor<ABI, S> {
	return {
		version: '1.0.0',
		construct: () => ({transfers: 0}),
		onTransfer(json) { json.transfers += countBy; },   // <- identical SOURCE either way
	};
}

fromJSProcessor(proc(1))().getCodeFingerprint()   // 'fp-h1pnr8fy'
fromJSProcessor(proc(10))().getCodeFingerprint()  // 'fp-h1pnr8fy'   <- the same
```

Two processors that compute demonstrably different state, and drift detection reports nothing, because `Function.prototype.toString()` returns the same characters for both.

## Why both mechanisms miss it at once

This is not merely "the advisory half is advisory". The two guards are blind for two different reasons and the blind spots coincide:

- **`getVersionHash()`** is `${version}-${simple_hash({config})}`. A captured value is not `config` unless it arrived through `configure()`, so the hash does not move.
- **`getCodeFingerprint()`** is the source text, which is byte-identical.

So a processor parameterised by a factory argument rather than by `configure()` has NO guard at all: previously computed state is adopted under different logic, silently, and even the loud error-level drift report does not fire. That is precisely the failure `processor-version-hash-cannot-silently-lie` was built to close, reachable through a door it did not consider.

Note the shape it takes: this is worse than the case that task DID consider. Decision 7 records that an all-native processor (every handler bound or proxied) answers `undefined` rather than a hash, because a constant "would be the same silent lie as `unknown`". Here the answer is not `undefined`, it is a perfectly good hash **of the wrong thing**, so nothing downstream can tell it is uninformative.

## How reachable is it

A factory is the repository's own documented shape: `fromJSProcessor` explicitly accepts `() => JSProcessor` as well as a plain object, and examples export a `createProcessor(...)`. Whether a given factory CAPTURES anything behaviour-bearing varies, and plenty capture nothing. The hazard is that nothing distinguishes the two cases, and the safe-looking one and the unsafe one are written identically.

## Not acted on

Recorded rather than fixed, because every available fix is a trade rather than a correction:

- **Hash the captured environment.** Not reachable from a function object in JavaScript. There is no reflective access to a closure's scope.
- **Refuse a factory.** Removes a documented authoring shape, and would not catch a captured value passed to a class constructor either.
- **Fold the factory ARGUMENTS into the version hash.** Only possible where they pass through a surface the core sees, which is exactly what `configure()` already is. The real advice may simply be: **put behaviour-bearing parameters through `configure()`, where they are hashed, and not through a closure.** That is documentation, and it is the cheapest thing here.
- **Report `undefined` when a handler closes over anything.** Undecidable without parsing, and over-reporting turns the fingerprint off for correct processors.

The documentation option looks strongest and costs nothing: `ProcessorConfig` exists, `configure()` is hashed into the version, and an author who routes parameters through it gets both guards working. Worth stating on the `version` doc comment and wherever `fromJSProcessor`'s factory form is described.
