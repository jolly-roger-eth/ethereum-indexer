/**
 * What does DECODING cost on a replay from the stored stream, next to the cost
 * of the work it exists to enable?
 *
 *   npx tsx measure.ts
 *
 * Writes `results/measure.json`, the raw evidence the finding cites. Runs
 * OFFLINE against `results/stratagems-alpha1-full.stream.json.gz` (captured
 * once by `capture-full.mjs`), so every term sees the same bytes.
 *
 * The question behind the spike: `the-stream-stores-only-what-the-node-said`
 * (work/specs/proposed/) would store the RAW half only, so a replay after a
 * processor change pays decode-on-read (`reparse`) instead of trusting stored
 * `args`. Is that decode a cost worth worrying about, next to the read and the
 * re-processing that a replay also pays? Nothing in the repo measured it: the
 * committed conformance fixture omits `data`/`topics` (nothing to decode), and
 * the sqlite-in-the-browser spike timed `fetch+parse-fixture` (JSON.parse), not
 * ABI decoding.
 *
 * Three terms, all measured through PRODUCTION code rather than a re-implementation:
 *
 *   read    gunzip + JSON.parse + `taggedBnReviver` (the same codec
 *           `parseStreamFixture` applies) over the gzipped fixture.
 *   decode  `LogEventFetcher.reparse` — the exact method the indexer's load path
 *           calls on a cached stream (ADR-0034). Measured TWICE: over the
 *           raw-ONLY events (the shape the proposed spec would store) and over
 *           the full raw+decoded events (the shape today's stream holds), so the
 *           strip's effect on the decode term is visible rather than assumed.
 *   process the vendored stratagems `JSProcessor` driven through
 *           `@etherfold/js-processor` exactly as the oracle in the
 *           sqlite-in-the-browser spike drives it — the re-processing a
 *           processor change exists to re-run.
 *
 * A cost with no correctness check would be worth nothing, so the decode term
 * is VERIFIED: reparse over raw-only events must land on the same decoded events
 * as reparse over full events, and both must agree with the `args` the capture
 * itself decoded (sampled), which is also the spec's premise (the raw half is
 * enough) checked on real bytes.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import {fileURLToPath} from 'node:url';
import * as os from 'node:os';
import {performance} from 'node:perf_hooks';
import {execFileSync} from 'node:child_process';
import {
	blocksOf,
	parseStreamFixture,
	serializeStreamFixture,
	taggedBnReplacer,
	type LogEvent,
} from '../../../packages/core/dist/index.js';
// `LogEventFetcher` is internal (not re-exported from the package index); the
// dist file is imported by path so the measurement runs the production decoder.
import {LogEventFetcher} from '../../../packages/core/dist/internal/decoding/LogEventFetcher.js';
import {fromJSProcessor} from '../../../packages/js-processor/dist/index.js';
// eslint-disable-next-line import/no-relative-packages-imports
import {StratagemsIndexerProcessor} from '../../../packages/conformance-workload-stratagems/vendor/stratagems/js-processor.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'results/stratagems-alpha1-full.stream.json.gz');
const RESULT_OUT = path.join(HERE, 'results/measure.json');

const WARMUP = 2;
const RUNS = 5;

/** `hrtime` in ms. */
const now = () => performance.now();

async function msAsync(fn: () => Promise<unknown>) {
	const start = now();
	const value = await fn();
	return {ms: now() - start, value};
}

function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

// ---------------------------------------------------------------- the fixture

function readFixture(): ReturnType<typeof parseStreamFixture> {
	return parseStreamFixture(zlib.gunzipSync(fs.readFileSync(FIXTURE)).toString('utf-8'));
}

const fixture = readFixture();
const events = fixture.eventStream as LogEvent<any>[];
console.log(
	`fixture: ${events.length} events, ${blocksOf(fixture).length} blocks ` +
		`(${fixture.provenance.fromBlock} to ${fixture.provenance.toBlock} on chain ${fixture.provenance.chainId})`,
);

/** The stored shape the proposed spec would write: the raw half only. */
function rawOnly(events: LogEvent<any>[]): LogEvent<any>[] {
	return events.map((event) => {
		const {args: _a, eventName: _e, decodeError: _d, ...raw} = event as any;
		return raw as LogEvent<any>;
	});
}

/** The shape today's committed fixture holds: the decoded half only. */
function decodedOnly(events: LogEvent<any>[]): LogEvent<any>[] {
	return events.map((event) => {
		const {topics: _t, data: _d, ...decoded} = event as any;
		return decoded as LogEvent<any>;
	});
}

const rawEvents = rawOnly(events);
const decodedEvents = decodedOnly(events);

// ------------------------------------------------------------------ the terms

const contracts = (fixture.source.contracts as any[]).map((c) => ({address: c.address, abi: c.abi}));
const dummyProvider = {
	request: async () => {
		throw new Error('no node in a replay');
	},
};
// The merged three-contract source is REFUSED by `LogEventFetcher`'s
// construction-time ambiguity guard since #28 (`Approval(address,address,uint256)`
// is Stratagems' ERC-721-style event and Gems' ERC-20-style one), so the spike
// constructs ONE fetcher per contract and routes each event by its ADDRESS —
// which is the same decode decision the merged fetcher makes per event
// (`decodeOnto` keys the ABI by the log's address). Recorded in the README.
const fetchers = new Map<string, LogEventFetcher<any>>();
for (const contract of contracts) {
	fetchers.set(
		(contract.address as string).toLowerCase(),
		new LogEventFetcher(dummyProvider as any, [contract] as any, {}, undefined),
	);
}

/** `reparse` routed by address: the per-event decode the merged fetcher does. */
function reparse(events: LogEvent<any>[]): LogEvent<any>[] | undefined {
	const out: LogEvent<any>[] = new Array(events.length);
	const groups = new Map<string, {indices: number[]; events: LogEvent<any>[]}>();
	for (let i = 0; i < events.length; i++) {
		const address = ((events[i] as any).address as string).toLowerCase();
		const fetcher = fetchers.get(address);
		if (!fetcher) throw new Error(`no fetcher for address ${address}`);
		let group = groups.get(address);
		if (!group) {
			group = {indices: [], events: []};
			groups.set(address, group);
		}
		group.indices.push(i);
		group.events.push(events[i]);
	}
	for (const [address, group] of groups) {
		const reparsed = fetchers.get(address).reparse(group.events);
		if (!reparsed) return undefined;
		for (let j = 0; j < reparsed.length; j++) {
			out[group.indices[j]] = reparsed[j];
		}
	}
	return out;
}

// ---------------------------------------------------------------- correctness

function canonical(value: unknown): string {
	return JSON.stringify(value, taggedBnReplacer);
}

// `oracle.load`/`oracle.process` are async (`JSObjectEventProcessor`), so the
// correctness pass awaits them.
const correctness = await msAsync(async () => {
	const fromRaw = reparse(rawEvents);
	const fromFull = reparse(events);
	if (!fromRaw || !fromFull) throw new Error('reparse returned undefined (raw half missing)');
	if (fromRaw.length !== events.length || fromFull.length !== events.length) {
		throw new Error(`reparse length mismatch: ${fromRaw.length}/${fromFull.length} vs ${events.length}`);
	}
	for (let i = 0; i < events.length; i++) {
		if (canonical(fromRaw[i]) !== canonical(fromFull[i])) {
			throw new Error(`reparse(raw-only) and reparse(full) disagree at event ${i}`);
		}
	}
	// The spec's premise, checked on real bytes: decoding the raw half lands on
	// the args the capture itself decoded. Sampled (every 500th event) — the
	// full comparison against `events` is already covered by `fromFull` above,
	// because `fromFull` discards and re-derives args the same way.
	for (let i = 0; i < events.length; i += 500) {
		if (canonical({args: (fromRaw[i] as any).args, eventName: (fromRaw[i] as any).eventName}) !==
			canonical({args: (events[i] as any).args, eventName: (events[i] as any).eventName})) {
			throw new Error(`decoded args disagree with the capture at event ${i}`);
		}
	}
	return {checkedEvents: events.length, sampledVsCapture: Math.ceil(events.length / 500)};
});

// ----------------------------------------------------------------- the timings

async function repeat(label: string, fn: () => unknown | Promise<unknown>): Promise<{
	label: string;
	runs: number[];
	medianMs: number;
}> {
	for (let i = 0; i < WARMUP; i++) await fn();
	const runs: number[] = [];
	for (let i = 0; i < RUNS; i++) {
		const start = now();
		await fn();
		runs.push(now() - start);
	}
	console.log(
		`  ${label}: median ${median(runs).toFixed(1)} ms  (runs: ${runs.map((r) => r.toFixed(1)).join(', ')})`,
	);
	return {label, runs, medianMs: median(runs)};
}

console.log(`measuring (warmup ${WARMUP} + ${RUNS} runs, node ${process.version}):`);

const read = await repeat('read (gunzip + JSON.parse + reviver)', () => readFixture());
const decodeRawOnly = await repeat('decode: reparse(raw-only) — the proposed stored shape', () =>
	reparse(rawEvents),
);
const decodeFull = await repeat("decode: reparse(full) — today's stored shape", () => reparse(events));

/** The oracle replay, as the sqlite-in-the-browser spike drives it. */
async function processReplay(): Promise<unknown> {
	const createProcessor = fromJSProcessor(() => StratagemsIndexerProcessor as any);
	const oracle = createProcessor();
	oracle.configure(undefined as any);
	await oracle.load(fixture.source as any, {finality: 12});
	let state;
	for (const block of blocksOf(fixture)) {
		state = await oracle.process(block.events as any, {
			context: fixture.lastSync.context,
			latestBlock: block.number,
			lastFromBlock: block.number,
			lastToBlock: block.number,
			unconfirmedBlocks: [],
		});
	}
	return state;
}

const processTerm = await repeat('process: the vendored stratagems JSProcessor over every block', () => processReplay());

// ---------------------------------------------------------------- the SIZES

/** JSON bytes + gzipped bytes of one shape, so the storage side is on the same bytes. */
function sizeOf(shape: LogEvent<any>[]): {jsonBytes: number; gzBytes: number} {
	const text = serializeStreamFixture({...fixture, eventStream: shape} as any);
	return {jsonBytes: Buffer.byteLength(text), gzBytes: zlib.gzipSync(Buffer.from(text)).length};
}

const sizes = {
	events: events.length,
	full: sizeOf(events),
	rawOnly: sizeOf(rawEvents),
	decodedOnly: sizeOf(decodedEvents),
};

// -------------------------------------------------------------------- output

const result = {
	measuredAt: new Date().toISOString(),
	commit: execFileSync('git', ['-C', HERE + '/../..', 'rev-parse', 'HEAD'], {encoding: 'utf-8'}).trim(),
	runtime: {
		node: process.version,
		cpu: os.cpus()[0].model,
		cores: os.cpus().length,
		machine: `${os.type()} ${os.release()}`,
	},
	fixture: {
		path: 'docs/spikes/replay-parse-cost/results/stratagems-alpha1-full.stream.json.gz',
		events: events.length,
		blocks: blocksOf(fixture).length,
		provenance: fixture.provenance,
	},
	methodology: {warmup: WARMUP, runs: RUNS, note: 'median of runs; each decode run parses all events, each process run replays all blocks'},
	correctness: correctness.value,
	timingsMs: {
		read: read,
		decodeRawOnly: decodeRawOnly,
		decodeFull: decodeFull,
		process: processTerm,
	},
	perThousandEvents: {
		read: (read.medianMs / events.length) * 1000,
		decodeRawOnly: (decodeRawOnly.medianMs / events.length) * 1000,
		decodeFull: (decodeFull.medianMs / events.length) * 1000,
		process: (processTerm.medianMs / events.length) * 1000,
	},
	replayComposition: {
		// a processor-change reindex from the stored stream, post-spec shape:
		read: read.medianMs,
		decode: decodeRawOnly.medianMs,
		process: processTerm.medianMs,
		total: read.medianMs + decodeRawOnly.medianMs + processTerm.medianMs,
	},
	sizes,
};

fs.writeFileSync(RESULT_OUT, JSON.stringify(result, null, 2));
console.log(`\nwrote ${RESULT_OUT}`);
console.log(
	`replay (post-spec stored shape): read ${read.medianMs.toFixed(0)} ms + ` +
		`decode ${decodeRawOnly.medianMs.toFixed(0)} ms + process ${processTerm.medianMs.toFixed(0)} ms ` +
		`= ${result.replayComposition.total.toFixed(0)} ms total`,
);