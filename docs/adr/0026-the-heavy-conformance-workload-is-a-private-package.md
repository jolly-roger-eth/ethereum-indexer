# The heavy conformance workload is its own package, and it is never published

The captured stratagems stream, the state that game's original `JSProcessor` computed from it, the processor ported onto `MutationContext`, and the vendored oracle all live in **`@etherfold/conformance-workload-stratagems`**, a workspace package marked `private` that nothing else depends on. It runs the workload against every backend from its OWN `test/`, rather than being depended on by each backend the way `@etherfold/state-store-conformance` is (ADR-0020).

## Why not inside `@etherfold/state-store-conformance`

That is the obvious home, and it is refused for a mechanical reason and a licence one.

Mechanically, running a real processor needs `@etherfold/processor-entities`, whose own tests devDepend on `@etherfold/state-store-sqlite`, which devDepends on `state-store-conformance`. Adding `processor-entities` to the suite closes that into a workspace cycle, and `pnpm -r`'s topological build order is exactly what a cycle breaks. Inverting it instead -- a package that depends on the suite, on the authoring API and on every backend, and that nothing depends on -- has no cycle to break and puts the four backend factories in one file next to the workload they carry.

## Why `private`, and why that is the load-bearing half

The vendored oracle is stratagems at commit `3d5a0b3f`, which is **GPL-3.0**, while this repository is MIT. Both are the same author's work and using it here as a test fixture is exactly what it is for, but `src/processor.ts` and `src/stratagems-contract.ts` are derived works of it, so publishing them to npm under this repository's MIT licence would MISSTATE what they are. Marking the package private is what makes the licence note (repeated in `vendor/stratagems/README.md` and the package README) true rather than decorative. The fixture's weight, about 1.3 MB of committed capture and golden state, would be a second reason on its own but is not the reason.

## Consequences

- **Its `license` field says `GPL-3.0-only`, and it is the only package here that does not say `MIT`.** The manifest is where a reader and every licence scanner look first, so leaving it at the repository's `MIT` would restate inside the package exactly the misstatement this ADR refuses to publish. It costs nothing (the package is `private`), and a reader who notices the odd field is one click from `vendor/stratagems/README.md`.
- **`packages/` now holds a package that is not a published artifact.** Its `build` script is a no-op that says so; `typecheck` and `test` are real. A reader who assumes every folder under `packages/` ships needs this ADR, which is most of why it exists.
- **Nothing can import the workload.** If a future backend outside this repository wants it, the answer is to run the suite plus its own fixture, not to depend on a GPL-derived processor.
- **The fast/full split lives with the workload, not with the suite.** The small hand-written cases stay fast and unconditional everywhere; the 31,332-event replay runs in CI and on demand. Which backends the heavy replay covers is a property of the runner, not of the backends: on `fake-indexeddb` it costs about half an hour and degrades quadratically, so it is opt-in there and the real evidence for that backend at this scale is a real engine.
