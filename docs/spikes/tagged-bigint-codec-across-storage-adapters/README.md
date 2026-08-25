# Migrating the two COMMITTED artifacts onto the tagged BigInt codec

Moving every storage adapter from the `"123n"` suffix convention to the tagged one (`{"__bigint__": "123"}`) was mostly a change of code. Two things it touched are **files on disk in the encoding being replaced**, and those are what these two scripts are for:

- `packages/conformance-workload-stratagems/fixtures/stratagems-{base,alpha1}.stream.json[.gz]` — the golden INPUT, a `StreamFixture`.
- `packages/conformance-workload-stratagems/fixtures/stratagems-{base,alpha1}.state.json` — the golden OUTPUT, the state the ORIGINAL stratagems `JSProcessor` computed from that stream.

They were **re-encoded once**, rather than read through a compatibility path. A compatibility path would have kept the ambiguity alive in the reader, which is the thing the whole change removes.

Both scripts are plain node ESM, run from the repository root, after `pnpm build`. They import the REAL codec out of `packages/core/dist`, so neither is a second implementation that can drift from the one under test.

## `reencode-stream-fixtures.mjs`

Rewrites a format-1 fixture as format 2. `--check` scans without writing.

Reading a format-1 file necessarily makes the guess format 1 could not avoid: every string of digits ending in `n` is taken to be a BigInt. That information was lost at CAPTURE time and nothing recovers it in general, so the honest statement is that the migration inherits format 1's guess exactly once, and after it there is no guess left.

For these two files the guess is **decidable**, because a fixture carries its own `source` and therefore its own ABIs. The script does not claim it, it refuses to write unless every legacy-shaped string it is about to convert sits at an `eventStream[].args` path whose declared type is an integer. All 57,846 of them do: `uint64` positions, `uint256` amounts / token ids / timestamps / values, `uint112` and `uint104` points. The only non-numeric argument either deployment declares is a `bytes24` commitment hash, which is `0x`-prefixed and cannot have the shape.

## `prove-goldens-unchanged.mjs`

The check that matters, and it is not `git diff`. Both files were rewritten by this task, so of course they differ; the question is whether the STATE behind the rendering moved.

It reads the NEW golden, decodes it with the new reviver, re-renders it in the OLD encoding (sorted keys, `"123n"`, indent 2 — exactly what `canonical` produced before), and compares byte-for-byte against the golden as committed at the baseline (`b40298e`, the last commit whose goldens are format 1).

```
$ node docs/spikes/tagged-bigint-codec-across-storage-adapters/prove-goldens-unchanged.mjs
stratagems-base.state.json: IDENTICAL to b40298e once re-rendered (2 BigInts)
stratagems-alpha1.state.json: IDENTICAL to b40298e once re-rendered (138 BigInts)
```

Byte-identical means the whole pipeline — re-encoded stream, migrated replay, migrated renderer — put out precisely the state it put out before, value for value and type for type. Note the direction: NEW is projected onto OLD. Projecting old onto new would have to guess which `"123n"` strings were BigInts, which is the very ambiguity being removed, and a check that has to guess proves nothing.

`pnpm --filter @etherfold/conformance-workload-stratagems test:full` is the same claim from the other end, on all 31,332 events.

## Re-running any of this

The scripts are idempotent: `reencode-stream-fixtures.mjs` reports "already format 2, nothing to do" once the migration has landed, and `prove-goldens-unchanged.mjs` keeps passing against `b40298e` for as long as the goldens genuinely hold the same state. If it ever starts failing, that is a **finding** about the processor or the replay path, not a fixture to update — the same rule `fixtures/README.md` states.
