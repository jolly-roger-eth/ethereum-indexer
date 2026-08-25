/**
 * ONE-OFF: re-encode a committed `StreamFixture` from format 1 to format 2.
 *
 *   node docs/spikes/tagged-bigint-codec-across-storage-adapters/reencode-stream-fixtures.mjs [--check]
 *
 * Run from the repository root, after `pnpm build` (it imports the REAL encoder
 * out of `packages/core/dist`, so what it writes is byte-for-byte what
 * `saveStreamFixture` would write, rather than a second implementation that
 * could drift from it).
 *
 * ## Why this exists
 *
 * Format 1 wrote BigInts by suffixing their decimal form with `n`. Format 2 tags
 * them (`{__bigint__: "123"}`), because `"123n"` is ALSO a legal string for a
 * contract to emit and the reader could not tell the two apart. The two fixtures
 * this repo commits are files on disk in the format being replaced, so the
 * change is not free: they are re-encoded ONCE, here, rather than read through a
 * compatibility path that would keep the ambiguity alive in the reader forever.
 *
 * ## The one guess, made once -- and CHECKED rather than asserted
 *
 * Reading a format-1 file necessarily makes the guess format 1 could not avoid:
 * every string of digits ending in `n` is taken to be a BigInt. That information
 * was lost at CAPTURE time and nothing can recover it in general, so the honest
 * statement is that this migration inherits format 1's guess exactly once and
 * after it there is no guess left to make.
 *
 * For THESE files the guess is decidable, because the fixture carries its own
 * `source` and therefore its own ABIs. So rather than claim it, this refuses to
 * write unless every legacy-shaped string it is about to convert sits at an
 * `args` path whose DECLARED type is an integer. (It is: `uint64` positions,
 * `uint256` amounts / token ids / timestamps, `uint112` and `uint104` points.
 * The only non-numeric argument either deployment declares is a `bytes24`
 * commitment hash, which is `0x`-prefixed and cannot have the shape.)
 *
 * The proof that the re-encoding changed no MEANING is separate and stronger:
 * `prove-goldens-unchanged.mjs` replays the migrated stream and shows the state
 * it produces is the same state, value for value, as the one committed before.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {serializeStreamFixture} from '../../../packages/core/dist/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '../../../packages/conformance-workload-stratagems/fixtures');
const FILES = [
	path.join(FIXTURES, 'stratagems-base.stream.json'),
	path.join(FIXTURES, 'stratagems-alpha1.stream.json.gz'),
];

const LEGACY_LITERAL = /^-?\d+n$/;
/** Format 1's reviver, kept HERE and nowhere else: it is history, not a code path. */
const legacyReviver = (_key, value) =>
	typeof value === 'string' && LEGACY_LITERAL.test(value) ? BigInt(value.slice(0, -1)) : value;

const isGzipped = (file) => file.endsWith('.gz');
const read = (file) =>
	isGzipped(file) ? zlib.gunzipSync(fs.readFileSync(file)).toString('utf-8') : fs.readFileSync(file, 'utf-8');
const write = (file, text) => fs.writeFileSync(file, isGzipped(file) ? zlib.gzipSync(text) : text);

/** Every declared event-argument type in the fixture's own source, by leaf name. */
function declaredArgTypes(fixture) {
	const byName = new Map();
	const collect = (inputs) => {
		for (const input of inputs) {
			if (input.components) collect(input.components);
			else (byName.get(input.name) ?? byName.set(input.name, new Set()).get(input.name)).add(input.type);
		}
	};
	for (const contract of fixture.source.contracts) {
		for (const item of contract.abi) if (item.type === 'event') collect(item.inputs);
	}
	return byName;
}

/** Where every legacy-shaped STRING sits, generalised over array indices. */
function legacyShapedPaths(value, at = '$', into = new Map()) {
	if (typeof value === 'string') {
		if (LEGACY_LITERAL.test(value)) into.set(at, (into.get(at) ?? 0) + 1);
	} else if (Array.isArray(value)) {
		for (const item of value) legacyShapedPaths(item, `${at}[]`, into);
	} else if (value && typeof value === 'object') {
		for (const key of Object.keys(value)) legacyShapedPaths(value[key], `${at}.${key}`, into);
	}
	return into;
}

const INTEGER = /^u?int\d*(\[\d*\])?$/;
const checkOnly = process.argv.includes('--check');
let wrote = 0;

for (const file of FILES) {
	const text = read(file);
	const raw = JSON.parse(text); // no reviver: this is the scan, verbatim
	if (raw.format === 2) {
		console.log(`${path.basename(file)}: already format 2, nothing to do`);
		continue;
	}
	if (raw.format !== 1) throw new Error(`${file}: format ${raw.format}, which this migration does not know`);

	const paths = legacyShapedPaths(raw);
	const total = [...paths.values()].reduce((a, b) => a + b, 0);
	console.log(`${path.basename(file)}: format 1, ${total} legacy-shaped strings`);

	const types = declaredArgTypes(raw);
	const refusals = [];
	for (const [at, count] of [...paths].sort()) {
		// Only a decoded ARG can legitimately have been a BigInt. Anything else with
		// this shape is a digest or a provenance string and must NOT be converted.
		if (!at.startsWith('$.eventStream[].args.')) {
			refusals.push(`${at}: not an event argument`);
			continue;
		}
		const leaf = at.replace(/\[\]$/, '').split('.').pop();
		const declared = [...(types.get(leaf) ?? [])];
		if (declared.length === 0 || !declared.every((type) => INTEGER.test(type))) {
			refusals.push(`${at}: declared ${declared.join('/') || '(nothing)'}, which is not an integer`);
			continue;
		}
		console.log(`    ${String(count).padStart(6)}  ${at}  (${declared.join('/')})`);
	}
	if (refusals.length > 0) {
		throw new Error(`${file}: refusing to convert:\n  ${refusals.join('\n  ')}`);
	}
	if (checkOnly) continue;

	const fixture = JSON.parse(text, legacyReviver);
	fixture.format = 2;
	write(file, serializeStreamFixture(fixture, 2));
	wrote++;
	console.log(`  -> rewritten as format 2`);
}

console.log(checkOnly ? 'checked, nothing written' : `${wrote} file(s) rewritten`);
