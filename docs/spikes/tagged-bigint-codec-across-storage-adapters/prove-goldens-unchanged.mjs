/**
 * The PROOF that moving the stratagems workload onto the tagged codec changed
 * the ENCODING of its golden states and nothing else about them.
 *
 *   node docs/spikes/tagged-bigint-codec-across-storage-adapters/prove-goldens-unchanged.mjs [<baseline-git-rev>]
 *
 * Run from the repository root. The baseline defaults to `b40298e`, the commit
 * this task started from, i.e. the last one whose goldens are in format 1.
 *
 * ## What it actually establishes, and why the obvious check would not
 *
 * The committed golden state is the state the ORIGINAL stratagems `JSProcessor`
 * computed from the committed stream: a diff on it means the processor changed
 * MEANING, which is a finding rather than a fixture update. This task rewrote
 * both files -- the stream (format 1 -> 2) and the golden rendered from it
 * (suffix -> tag) -- so `git diff` on either says nothing: of course they
 * differ, that is the task.
 *
 * The question worth answering is whether the STATE behind the rendering moved.
 * So this reads the NEW golden, decodes it with the new reviver, re-renders it
 * in the OLD encoding (sorted keys, `"123n"`, two-space indent, exactly what
 * `canonical` produced before), and compares that byte-for-byte against the
 * golden as committed at the baseline. Byte-identical means the whole pipeline
 * -- re-encoded stream, migrated replay, migrated renderer -- put out precisely
 * the state it put out before, value for value and type for type.
 *
 * Note the direction: NEW is projected onto OLD, not the other way round.
 * Projecting old onto new would have to guess which `"123n"` strings were
 * BigInts, which is the very ambiguity being removed, and a check that has to
 * guess proves nothing.
 */
import {execFileSync} from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {taggedBnReviver} from '../../../packages/core/dist/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const BASELINE = process.argv[2] ?? 'b40298e';
const GOLDENS = [
	'packages/conformance-workload-stratagems/fixtures/stratagems-base.state.json',
	'packages/conformance-workload-stratagems/fixtures/stratagems-alpha1.state.json',
];

/** `canonical` as it stood in format 1: sorted keys, `"123n"`, indent 2. */
const legacyReplacer = (_key, value) => (typeof value === 'bigint' ? `${value}n` : value);
function sortKeys(value) {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value && typeof value === 'object') {
		const out = {};
		for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
		return out;
	}
	return value;
}
const legacyCanonical = (value) => JSON.stringify(sortKeys(value), legacyReplacer, 2);

/** The first places two renderings diverge, so a failure names itself. */
function firstDifferences(expected, actual, limit = 4) {
	const left = expected.split('\n');
	const right = actual.split('\n');
	const diffs = [];
	for (let i = 0; i < Math.max(left.length, right.length) && diffs.length < limit; i++) {
		if (left[i] !== right[i]) diffs.push(`line ${i + 1}:\n  baseline: ${left[i]}\n  now:      ${right[i]}`);
	}
	return diffs;
}

let failed = 0;
for (const relative of GOLDENS) {
	const now = JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf-8'), taggedBnReviver);
	const asItWouldHaveBeen = legacyCanonical(now);
	const baseline = execFileSync('git', ['show', `${BASELINE}:${relative}`], {cwd: ROOT, maxBuffer: 1 << 30}).toString(
		'utf-8',
	);

	const bigints = (JSON.stringify(now, (_k, v) => (typeof v === 'bigint' ? 'B' : v)).match(/"B"/g) ?? []).length;
	if (asItWouldHaveBeen === baseline) {
		console.log(`${path.basename(relative)}: IDENTICAL to ${BASELINE} once re-rendered (${bigints} BigInts)`);
	} else {
		failed++;
		console.log(`${path.basename(relative)}: DIFFERS from ${BASELINE}. That is a finding, not a fixture update.`);
		for (const line of firstDifferences(baseline, asItWouldHaveBeen)) console.log(line);
	}
}

process.exit(failed === 0 ? 0 : 1);
