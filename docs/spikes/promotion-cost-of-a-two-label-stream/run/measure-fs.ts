/**
 * The filesystem half of the measurement.
 *
 *   npx tsx run/measure-fs.ts                        the default sweep
 *   SPIKE_SIZES=1x,4x npx tsx run/measure-fs.ts      a quicker pass
 *   SPIKE_SEAL=200,1000,5000 npx tsx run/measure-fs.ts
 *
 * Writes `results/fs.json`, which is the raw evidence the finding cites.
 *
 * The seal threshold is swept on purpose: it is the axis that separates the two
 * layouts. A rename costs per SEGMENT and a rewrite costs per BYTE, so at a
 * fixed history a coarser seal makes key-label cheaper and leaves value-label
 * where it was. If that is not what the numbers say, the model is wrong.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {keyLabelLayout, valueLabelLayout, type Layout, type PromotionCost} from '../src/layouts.js';
import {fsPort} from '../src/port-fs.js';
import {GRAFT_FRACTION, REPEATS, segmentise, type Fixture, type SharingCase, type Size} from '../src/workload.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(HERE, '../results');
const FIXTURE = path.join(
	HERE,
	'../../../../packages/conformance-workload-stratagems/fixtures/stratagems-alpha1.stream.json.gz',
);

const SIZES = (process.env.SPIKE_SIZES ?? '1x,4x,8x').split(',') as Size[];
const SEALS = (process.env.SPIKE_SEAL ?? '250,1000,4000').split(',').map(Number);
const CASES: SharingCase[] = ['whole-stream', 'partial-graft', 'no-sharing'];

/**
 * WHERE the segments are written, and it is not a detail.
 *
 * `os.tmpdir()` is `tmpfs` on most Linux boxes, where a rename and a rewrite are
 * both memory operations, so measuring there FLATTERS the rewrite arm and
 * understates the gap. The default is therefore a real disk directory; set
 * `SPIKE_DIR` to compare, and the chosen root is recorded in the results so a
 * reader can tell which substrate a number came from.
 */
const DIR_ROOT = process.env.SPIKE_DIR ?? path.join(os.homedir(), '.cache', 'etherfold-promotion-spike');

function loadFixture(): Fixture {
	return JSON.parse(zlib.gunzipSync(fs.readFileSync(FIXTURE)).toString());
}

type Row = {
	substrate: 'fs';
	layout: string;
	size: Size;
	sealAfter: number;
	sharingCase: SharingCase;
	segments: {live: number; staging: number};
	streamBytes: number;
	promotion: PromotionCost & {ms: number};
	syscalls: ReturnType<typeof fsPort>['counters'];
	readOrderLength: number;
};

/**
 * One promotion, set up and measured.
 *
 * The setup (writing the live and staging segments) is OUTSIDE the timed
 * section: it is the backfill that already happened, identical for both
 * layouts, and folding it in would measure the append this spike is not about.
 */
async function measure(
	layoutOf: (port: ReturnType<typeof fsPort>, stream: string) => Layout,
	segments: ReturnType<typeof segmentise>,
	sharingCase: SharingCase,
	size: Size,
	sealAfter: number,
): Promise<Row> {
	fs.mkdirSync(DIR_ROOT, {recursive: true});
	const folder = fs.mkdtempSync(path.join(DIR_ROOT, 'run-'));
	try {
		const port = fsPort(folder);
		const layout = layoutOf(port, 'stream_tag_1');

		// The live generation holds the whole history.
		for (let i = 0; i < segments.length; i++) await layout.append('live', i, segments[i]);

		// The graft point, and what staging therefore had to write for itself.
		const graftAt = Math.floor((segments.length - 1) * GRAFT_FRACTION[sharingCase]);
		const stagingSegments = segments.length - 1 - graftAt;

		// Staging numbers from the graft point where the layout allows it, and
		// after the live tail where it does not. `layouts.ts` explains why that is
		// forced rather than chosen.
		const startAt = layout.name === 'key-label' ? graftAt + 1 : segments.length;
		for (let i = 0; i < stagingSegments; i++) {
			await layout.append('staging', startAt + i, segments[graftAt + 1 + i]);
		}

		port.resetCounters();
		const t0 = performance.now();
		const cost = await layout.promote(graftAt);
		const ms = performance.now() - t0;
		// Snapshot BEFORE anything else touches the store: `readOrder` below is a
		// correctness check, not part of the promotion, and counting it would
		// charge each layout for a read it does not do at promotion time.
		const syscalls = {...port.counters};

		const readOrder = await layout.readOrder('live', graftAt);
		const streamBytes = segments.reduce((n, s) => n + JSON.stringify(s).length, 0);

		return {
			substrate: 'fs',
			layout: layout.name,
			size,
			sealAfter,
			sharingCase,
			segments: {live: segments.length, staging: stagingSegments},
			streamBytes,
			promotion: {...cost, ms},
			syscalls,
			readOrderLength: readOrder.length,
		};
	} finally {
		fs.rmSync(folder, {recursive: true, force: true});
	}
}

async function main() {
	const fixture = loadFixture();
	const rows: Row[] = [];

	for (const size of SIZES) {
		for (const sealAfter of SEALS) {
			const segments = segmentise(fixture, REPEATS[size], sealAfter);
			for (const sharingCase of CASES) {
				const arms = [
					keyLabelLayout,
					valueLabelLayout,
					(port: any, stream: string) => valueLabelLayout(port, stream, {pointer: true}),
				];
				for (const layoutOf of arms) {
					const row = await measure(layoutOf as any, segments, sharingCase, size, sealAfter);
					rows.push(row);
					console.log(
						`${row.layout.padEnd(20)} ${size.padStart(3)} seal=${String(sealAfter).padStart(4)} ` +
							`${sharingCase.padEnd(13)} segs=${String(row.segments.staging).padStart(4)} ` +
							`renames=${String(row.promotion.metadataRenames).padStart(4)} ` +
							`rewrites=${String(row.promotion.payloadsRewritten).padStart(4)} ` +
							`readMB=${(row.syscalls.bytesRead / 1e6).toFixed(1).padStart(6)} ` +
							`writeMB=${(row.syscalls.bytesWritten / 1e6).toFixed(1).padStart(6)} ` +
							`${row.promotion.ms.toFixed(1).padStart(8)}ms`,
					);
				}
			}
		}
	}

	fs.mkdirSync(RESULTS, {recursive: true});
	fs.writeFileSync(
		path.join(RESULTS, 'fs.json'),
		JSON.stringify(
			{
				ranAt: new Date().toISOString(),
				env: {
					node: process.version,
					platform: process.platform,
					arch: process.arch,
					cpus: os.cpus()[0]?.model,
					dirRoot: DIR_ROOT,
					dirIsTmpfs: DIR_ROOT.startsWith(os.tmpdir()),
				},
				note: 'ms is wall-clock on a loaded machine and is the WEAKER number; the work metrics (renames, rewrites, bytes) are what the finding rests on.',
				rows,
			},
			null,
			2,
		),
	);
	console.log(`\n${rows.length} rows -> results/fs.json`);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
