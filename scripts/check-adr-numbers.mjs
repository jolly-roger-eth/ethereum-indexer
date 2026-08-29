#!/usr/bin/env node
/**
 * Refuse two ADRs claiming the same number.
 *
 * ## Why this exists
 *
 * On 2026-08-28 `0032-the-acceptance-gate-does-not-assume-an-idle-machine.md` landed on `main`
 * while a branch was in flight that had already added its own `0032-...md`. Both existed on the
 * branch at once, `format:check`, `build`, `typecheck` and `test` were all green, and the collision
 * was caught only because a human happened to list the directory. The second was renumbered to 0033
 * by hand.
 *
 * It is exactly the mistake concurrent work produces: neither branch is wrong on its own, each
 * passes its own gate, and only the MERGE is wrong. Nothing before this file looked at the shape of
 * a filename in `docs/adr/`.
 *
 * The damage is quiet and grows with time, because an ADR number is a STABLE REFERENCE: source
 * comments cite it (19 `vitest.config.ts` files point at ADR-0032), so do `CONTEXT.md`, changesets
 * and other ADRs. Two documents under one number makes every one of those citations ambiguous, and
 * the ambiguity surfaces long after the context that would resolve it is gone.
 *
 * ## What it checks
 *
 * Two things, both of which make a citation unresolvable:
 *
 * - a DUPLICATE number (two files with the same `NNNN` prefix), reported with both filenames;
 * - a MALFORMED filename (any `.md` that is not `NNNN-slug.md`), because a document nobody can cite
 *   as ADR-NNNN is the same failure with the number missing rather than doubled. The shape is the
 *   one `work/protocol/ADR-FORMAT.md` already specifies, so this enforces the existing convention
 *   rather than inventing one. `README.md` is exempt: an index is not an ADR.
 *
 * It deliberately does NOT check for a GAP in the sequence. A hole is legitimate (a withdrawn ADR,
 * a number reserved on a branch that has not merged yet) and, unlike a duplicate, it makes no
 * citation ambiguous: nothing points at a number that does not exist.
 *
 * ## Usage
 *
 *   node scripts/check-adr-numbers.mjs             # check docs/adr
 *   node scripts/check-adr-numbers.mjs <dir>       # check some other directory
 *
 * Wired into the acceptance gate as `pnpm check:adr` (`dorfl.json` `verify`, and CI), since the
 * gate is the thing that would have caught the incident above. Dependency-free and in no workspace
 * package, on purpose: it must be able to run before anything is installed or built.
 *
 * The SELF-CHECK below runs first, every time. A validator that has never been observed to reject
 * anything is not known to work, and the real `docs/adr/` is (and should stay) a passing case, so
 * the failing cases are carried here as data and exercised on every run.
 */

import {readdirSync} from 'node:fs';

/** Where the ADRs live, per `work/protocol/ADR-FORMAT.md`. */
const DEFAULT_ADR_DIR = 'docs/adr';

/** The documented filename shape: a four-digit number, a dash, a slug. */
const ADR_FILENAME = /^(\d{4})-.+\.md$/;

/** Markdown in `docs/adr/` that is not an ADR and must not be judged as one. */
const NOT_AN_ADR = new Set(['README.md']);

/**
 * The whole check, as a pure function over filenames, so the FAILING cases can be asserted without
 * a fixture directory.
 *
 * @param {string[]} filenames
 * @returns {{duplicates: {number: string, files: string[]}[], malformed: string[]}}
 */
function checkAdrFilenames(filenames) {
	const byNumber = new Map();
	const malformed = [];
	for (const filename of [...filenames].sort()) {
		if (!filename.endsWith('.md') || NOT_AN_ADR.has(filename)) continue;
		const match = ADR_FILENAME.exec(filename);
		if (!match) {
			malformed.push(filename);
			continue;
		}
		const number = match[1];
		if (!byNumber.has(number)) byNumber.set(number, []);
		byNumber.get(number).push(filename);
	}
	const duplicates = [];
	for (const [number, files] of [...byNumber].sort(([a], [b]) => a.localeCompare(b))) {
		if (files.length > 1) duplicates.push({number, files});
	}
	return {duplicates, malformed};
}

/**
 * The cases the detector must get right, including the two it must REJECT. Asserted on every run:
 * if one of these ever passes, the check is broken and says so instead of reporting a clean
 * `docs/adr/` it never really examined.
 */
const SELF_CHECK_CASES = [
	{
		name: 'two files claiming 0032 collide, and both are named',
		files: ['0031-a.md', '0032-the-acceptance-gate.md', '0032-an-event-block-range.md'],
		expect: {
			duplicates: [{number: '0032', files: ['0032-an-event-block-range.md', '0032-the-acceptance-gate.md']}],
			malformed: [],
		},
	},
	{
		name: 'a filename with no leading number is malformed',
		files: ['0001-a.md', 'notes-on-something.md'],
		expect: {duplicates: [], malformed: ['notes-on-something.md']},
	},
	{
		name: 'a well-formed sequence passes, gaps and all',
		files: ['0001-a.md', '0002-b.md', '0007-c.md'],
		expect: {duplicates: [], malformed: []},
	},
	{
		name: 'a README index and non-markdown files are not ADRs',
		files: ['README.md', '.gitkeep', 'diagram.png', '0001-a.md'],
		expect: {duplicates: [], malformed: []},
	},
];

function runSelfCheck() {
	for (const testCase of SELF_CHECK_CASES) {
		const actual = checkAdrFilenames(testCase.files);
		if (JSON.stringify(actual) === JSON.stringify(testCase.expect)) continue;
		console.error(`the ADR filename check is BROKEN: ${testCase.name}`);
		console.error(`  expected ${JSON.stringify(testCase.expect)}`);
		console.error(`  got      ${JSON.stringify(actual)}`);
		process.exit(1);
	}
}

runSelfCheck();

const dir = process.argv[2] ?? DEFAULT_ADR_DIR;
let filenames;
try {
	filenames = readdirSync(dir);
} catch (err) {
	// A missing `docs/adr/` is fine (ADR-FORMAT.md says create it lazily); anything else is not.
	if (err.code === 'ENOENT') {
		console.log(`${dir}: no such directory, nothing to check`);
		process.exit(0);
	}
	throw err;
}

const {duplicates, malformed} = checkAdrFilenames(filenames);

for (const {number, files} of duplicates) {
	console.error(`${dir}: ${files.length} ADRs claim number ${number}:`);
	for (const file of files) console.error(`  ${file}`);
}
for (const file of malformed) {
	console.error(`${dir}: ${file} is not named NNNN-slug.md, so it cannot be cited as an ADR number`);
}

if (duplicates.length > 0 || malformed.length > 0) {
	console.error(
		'\nAn ADR number is a stable reference cited from source comments, CONTEXT.md, changesets and other\n' +
			'ADRs. Renumber all but one of the colliding files (highest unused number wins) and update anything\n' +
			'that cites the number being moved.',
	);
	process.exit(1);
}

const count = filenames.filter((f) => ADR_FILENAME.test(f)).length;
console.log(`${dir}: ${count} ADRs, no duplicate numbers (self-check: ${SELF_CHECK_CASES.length} cases, 2 rejecting)`);
