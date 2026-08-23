/**
 * Turn the raw per-run JSON into the tables the finding quotes.
 *
 *   npx tsx run/summarise.ts   ->  results/summary.md
 *
 * Nothing is computed here that is not in `results/browser-*.json`; this only
 * arranges it, so a reader who distrusts a table can go straight to the numbers
 * it came from.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(HERE, '../results');
const ENGINES = ['chromium', 'firefox', 'webkit'];

type Run = any;

function load(engine: string): Run[] {
	const file = path.join(RESULTS, `browser-${engine}.json`);
	if (!fs.existsSync(file)) return [];
	return JSON.parse(fs.readFileSync(file, 'utf-8')).runs ?? [];
}

/** The LAST run of a given shape wins: later runs re-measure the same thing. */
function latest(runs: Run[], match: (run: Run) => boolean): Run | undefined {
	const hits = runs.filter(match);
	return hits[hits.length - 1];
}

const lines: string[] = [];
lines.push('# Raw results, arranged', '');
lines.push(`Generated ${new Date().toISOString()} by \`run/summarise.ts\` from \`results/browser-*.json\`.`, '');

// ---------------------------------------------------------------- size sweep
lines.push('## Write, read and cold start by workload size', '');
lines.push(
	'`us/mutation` is the write cost divided by mutations, so batch size is normalised out. ' +
		'`us/read` is a point lookup by `(entity, id)` at the tip; for the SQLite candidates it is measured ' +
		'INSIDE the worker, so it excludes the page-to-worker round-trip a real caller would also pay.',
	'',
);
for (const engine of ENGINES) {
	const runs = load(engine);
	if (runs.length === 0) continue;
	lines.push(`### ${engine}`, '');
	lines.push('| backend | size | live rows | mut/block | ms/block | us/mutation | us/read | us/as-of | open ms | reopen ms | survived reload |');
	lines.push('| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: | --- |');
	for (const size of ['real', 'tiny', 'small', 'medium', 'large', 'sweep']) {
		for (const backend of [
			'memory',
			'idb-versioned',
			'idb-versioned-cached',
			'blob-structured-clone',
			'blob-json',
			'sqlite-opfs',
			'sqlite-opfs-sahpool',
		]) {
			const run = latest(runs, (r) => r.size === size && r.backend === backend && r.profile === 'laptop');
			if (!run?.write) continue;
			const w = run.write.results;
			if (run.write.errors.length > 0) {
				lines.push(`| ${backend} | ${size} | | | | | | | | | UNAVAILABLE: ${run.write.errors[0].split('|')[0].trim()} |`);
				continue;
			}
			const open = run.write.timings.find((t: any) => t.label === 'open')?.ms ?? 0;
			const reopen = run.reopen?.timings?.find((t: any) => t.label === 'open')?.ms ?? 0;
			const mutPerBlock = w.mutations / w.blocks;
			lines.push(
				`| ${backend}${w.vfsUsed && w.vfsUsed !== backend.replace('sqlite-', '') ? ` (fell back to ${w.vfsUsed})` : ''} ` +
					`| ${size} | ${w.liveRows} | ${mutPerBlock.toFixed(0)} | ${w.msPerBlock} | ` +
					`${((w.msPerBlock * 1000) / mutPerBlock).toFixed(0)} | ${(w.msPerPointRead * 1000).toFixed(0)} | ` +
					`${w.msPerAsOfRead ? (w.msPerAsOfRead * 1000).toFixed(0) : 'refused'} | ${open.toFixed(1)} | ` +
					`${reopen.toFixed(1)} | ${run.reopen?.results?.survived ?? 'n/a'} |`,
			);
		}
	}
	lines.push('');
}

// ------------------------------------------------------------- the crossover
lines.push('## The crossover: cost per mutation as the store grows', '');
lines.push(
	'One run of the `sweep` workload, which holds the batch roughly constant (100 to 128 mutations per block) ' +
		'and lets only the dataset grow, to 20,775 live rows over 476 blocks. Each column is a tenth of the run; ' +
		'the header is how many mutations had already been written when it started.',
	'',
);
for (const engine of ENGINES) {
	const runs = load(engine);
	const curves = runs
		.filter((r) => r.size === 'sweep' && r.profile === 'laptop' && r.write?.results?.writeCurve)
		.reduce((map: Record<string, any>, run) => ({...map, [run.backend]: run.write.results.writeCurve}), {});
	const backends = Object.keys(curves);
	if (backends.length === 0) continue;
	lines.push(`### ${engine} (microseconds per mutation)`, '');
	const header = curves[backends[0]].map((bucket: any) => bucket.rowsBefore);
	lines.push(`| backend | ${header.join(' | ')} |`);
	lines.push(`| --- | ${header.map(() => '--:').join(' | ')} |`);
	for (const backend of backends) {
		lines.push(
			`| ${backend} | ${curves[backend]
				.map((bucket: any) => (bucket.msPerMutation * 1000).toFixed(0))
				.join(' | ')} |`,
		);
	}
	lines.push('');
}

// ------------------------------------------------------------------ retention
lines.push('## Footprint by retention window', '');
for (const engine of ENGINES) {
	for (const run of load(engine)) {
		const retention = run.write?.results?.retention;
		if (!retention || Object.keys(retention).length === 0) continue;
		lines.push(`- **${engine} / ${run.backend} / ${run.size}**: \`${JSON.stringify(retention)}\``);
	}
}
lines.push('');

// ------------------------------------------------------------------ multi-tab
lines.push('## Multi-tab: four tabs, one origin, one database', '');
lines.push('| engine | backend | tabs that failed | first failure |');
lines.push('| --- | --- | --: | --- |');
for (const engine of ENGINES) {
	for (const run of load(engine).filter((r) => r.profile === 'multi-tab')) {
		const failure = (run.tabs ?? []).find((tab: any) => (tab.errors ?? []).length > 0);
		lines.push(
			`| ${engine} | ${run.backend} | ${run.tabsThatFailed}/4 | ${
				failure ? String(failure.errors[0]).split('|')[0].trim().slice(0, 120) : 'none'
			} |`,
		);
	}
}
lines.push('');

// -------------------------------------------------------------- device profile
lines.push('## Mid-range device profile (Chromium, 4x CPU throttle)', '');
lines.push('| backend | ms/block laptop | ms/block throttled | us/read laptop | us/read throttled |');
lines.push('| --- | --: | --: | --: | --: |');
for (const backend of ['idb-versioned', 'blob-structured-clone', 'sqlite-opfs-sahpool']) {
	const runs = load('chromium');
	const laptop = latest(runs, (r) => r.backend === backend && r.size === 'medium' && r.profile === 'laptop');
	const slow = latest(runs, (r) => r.backend === backend && r.size === 'medium' && r.profile === 'mid-range-4x');
	if (!laptop?.write || !slow?.write) continue;
	lines.push(
		`| ${backend} | ${laptop.write.results.msPerBlock} | ${slow.write.results.msPerBlock} | ` +
			`${(laptop.write.results.msPerPointRead * 1000).toFixed(0)} | ${(slow.write.results.msPerPointRead * 1000).toFixed(0)} |`,
	);
}
lines.push('');

// ------------------------------------------------------------ the light path
lines.push('## The light path: backwards replay over immer reverse patches', '');
lines.push('| engine | state | patch log (64 blocks) | depth 1 | depth 8 | depth 32 | depth 64 | all correct |');
lines.push('| --- | --: | --: | --: | --: | --: | --: | --- |');
for (const engine of ENGINES) {
	const run = latest(load(engine), (r) => r.backend === 'immer-patch-replay');
	if (!run?.write?.results?.depths) continue;
	const w = run.write.results;
	const at = (depth: number) => w.depths.find((entry: any) => entry.depth === depth)?.ms ?? '';
	lines.push(
		`| ${engine} | ${(w.stateBytes / 1024).toFixed(0)} KB | ${(w.patchLogBytes / 1024).toFixed(0)} KB | ` +
			`${at(1)} ms | ${at(8)} ms | ${at(32)} ms | ${at(64)} ms | ${w.allCorrect} |`,
	);
}
lines.push('');

fs.writeFileSync(path.join(RESULTS, 'summary.md'), lines.join('\n'));
console.log(`wrote ${path.relative(process.cwd(), path.join(RESULTS, 'summary.md'))}`);
