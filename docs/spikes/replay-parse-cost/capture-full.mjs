/**
 * Capture the stratagems-on-Base log stream ONCE, KEEPING the raw half.
 *
 *   node capture-full.mjs
 *
 * The conformance workload's committed fixture
 * (`packages/conformance-workload-stratagems/fixtures/stratagems-alpha1.stream.json.gz`)
 * omits `data` and `topics` to stay small, which is exactly why no existing
 * artifact can measure the cost of DECODING on replay: there is nothing left to
 * decode. This script re-captures the SAME pinned range (byte-identical logs
 * apart from `capturedAt`/`chainHeadAtCapture`, per the original fixture's
 * provenance) with BOTH halves present, into this spike's own `results/` — the
 * committed fixture is not touched.
 *
 * ## Why one capture PER CONTRACT
 *
 * The original capture (2026-08-22, commit d635f39) fetched all three contracts
 * through ONE `LogEventFetcher` over the merged ABI. Since then (#28, ADR-0034)
 * the fetcher REFUSES at construction time when the merged ABI declares the
 * same event signature twice with different decoding shapes — and this source
 * does exactly that: `Approval(address,address,uint256)` is Stratagems'
 * ERC-721-style `tokenID` event and Gems' ERC-20-style `value` event. So the
 * merged source can no longer construct a production fetcher at all (a finding
 * this spike records: the repo's own promoted conformance workload cannot be
 * captured or replayed through the production fetch path today; the conformance
 * tests replay through processors and never construct one).
 *
 * Per-contract captures have no ambiguity, and decoding per ADDRESS is what the
 * merged fetcher does per event anyway (`decodeOnto` keys the ABI by the log's
 * address), so the merged-and-sorted stream below is the same input the merged
 * fetcher would have produced.
 *
 * This is the only script in the spike that talks to a node; `measure.ts`
 * replays offline so its numbers are not at the mercy of a rate limiter.
 *
 * Needs `CHAIN_8453` in the repo's `.env.local` (a Base JSON-RPC endpoint).
 * Modeled on `docs/spikes/sqlite-in-the-browser/capture/capture-stratagems-base.mjs`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {
	captureStream,
	parseStreamFixture,
	serializeStreamFixture,
	simple_hash,
	taggedBnReplacer,
} from '../../../packages/core/dist/index.js';
// `sourceHashesOf` is internal (not re-exported from the package index); the
// dist file is imported by path so the fixture's context is the same producer
// the indexer persists.
import {sourceHashesOf} from '../../../packages/core/dist/internal/engine/eventRanges.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const STRATAGEMS = path.resolve(process.env.STRATAGEMS_REPO ?? `${process.env.HOME}/dev/github/wighawag/stratagems`);
const DEPLOYMENTS = path.join(STRATAGEMS, 'contracts/deployments/alpha1');
const OUT = path.join(HERE, 'results/stratagems-alpha1-full.stream.json.gz');
/** The committed fixture, whose logs the re-capture must reproduce exactly. */
const COMMITTED = path.join(
	REPO,
	'packages/conformance-workload-stratagems/fixtures/stratagems-alpha1.stream.json.gz',
);

/** Re-verify the already-captured fixture offline, without talking to a node. */
const VERIFY_ONLY = process.argv.includes('--verify-only');

/** Pinned, never `latest`, and the SAME pin as the committed fixture. */
const FROM_BLOCK = 12_082_307;
const TO_BLOCK = 23_400_000;

function envValue(key) {
	const text = fs.readFileSync(path.join(REPO, '.env.local'), 'utf-8');
	const match = text.match(new RegExp(`^${key}=(.*)$`, 'm'));
	if (!match) throw new Error(`${key} not found in .env.local`);
	return match[1].trim().replace(/^["']|["']$/g, '');
}

function deployment(name) {
	const json = JSON.parse(fs.readFileSync(path.join(DEPLOYMENTS, `${name}.json`), 'utf-8'));
	return {
		abi: json.abi,
		address: json.address.toLowerCase(),
		startBlock: parseInt(json.receipt.blockNumber, 16),
	};
}

function gitCommit(repo) {
	try {
		return execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], {encoding: 'utf-8'}).trim();
	} catch {
		return 'unknown';
	}
}

const url = envValue('CHAIN_8453');
const provider = VERIFY_ONLY ? null : {
	async request(args) {
		const response = await fetch(url, {
			method: 'POST',
			headers: {'content-type': 'application/json'},
			body: JSON.stringify({jsonrpc: '2.0', id: 1, ...args}),
		});
		const json = await response.json();
		if (json.error) {
			const error = new Error(json.error.message);
			error.code = json.error.code;
			throw error;
		}
		return json.result;
	},
};

// The same three contracts the stratagems indexer is configured with.
const contracts = [deployment('Stratagems'), deployment('Gems'), deployment('GemsGenerator')];
const fullSource = {chainId: '8453', contracts};

if (!VERIFY_ONLY) {
const chainIdHex = await provider.request({method: 'eth_chainId'});
if (parseInt(chainIdHex, 16).toString() !== fullSource.chainId) {
	throw new Error(`CHAIN_8453 points at chain ${parseInt(chainIdHex, 16)}, not Base`);
}
const latestBlock = parseInt(await provider.request({method: 'eth_blockNumber'}), 16);
if (latestBlock < TO_BLOCK) {
	throw new Error(`chain is only at ${latestBlock}, cannot capture up to ${TO_BLOCK}`);
}
}

// --------------------------------------------- one capture per contract, merged

const started = Date.now();
let merged = [];
if (VERIFY_ONLY) {
	const existing = parseStreamFixture(zlib.gunzipSync(fs.readFileSync(OUT)).toString('utf-8'));
	merged = existing.eventStream;
	console.log(`verify-only: ${merged.length} events from ${path.relative(REPO, OUT)}`);
}
if (VERIFY_ONLY) {
	// fall through to verification with `merged` loaded above
} else
for (const contract of contracts) {
	const perSource = {chainId: '8453', contracts: [contract]};
	const fixture = await captureStream(provider, perSource, {
		fromBlock: FROM_BLOCK,
		toBlock: TO_BLOCK,
		streamConfig: {finality: 12},
		fetch: {maxBlocksPerFetch: 100_000, numRetry: 12},
		onProgress: ({fromBlock, toBlock: to, events, totalEvents}) => {
			process.stdout.write(`  ${contract.address} ${fromBlock} -> ${to}: +${events} (${totalEvents})\n`);
		},
	});
	console.log(`${contract.address}: ${fixture.eventStream.length} events`);
	merged.push(...fixture.eventStream);
}

// Stream order: block, then log index — the order the merged filter returns and
// `blocksOf` groups. Stable for a same-block logIndex tie across contracts.
merged.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);

// ------------------------------- verify against the committed (trimmed) fixture

const committed = parseStreamFixture(zlib.gunzipSync(fs.readFileSync(COMMITTED)).toString('utf-8'));
/** Identity of one event, for a set difference that names what is missing. */
const identityOf = (e) => `${e.blockNumber}:${e.logIndex}:${(e.transactionHash || '').slice(0, 12)}`;
const committedIdentities = new Map(committed.eventStream.map((e, i) => [identityOf(e), i]));
const recapturedIdentities = new Map(merged.map((e, i) => [identityOf(e), i]));

const missingInRecapture = [...committedIdentities.keys()].filter((k) => !recapturedIdentities.has(k));
const extraInRecapture = [...recapturedIdentities.keys()].filter((k) => !committedIdentities.has(k));

// The committed fixture predates the topic0-filtered fetch (#26/#27): it holds
// two logs of events NEITHER artifact declares (`OwnershipTransferred`, an
// OpenZeppelin deployment event), captured by the old address-only filter and
// stored unparsed (`decodeError`, no `eventName`). Today's fetcher deliberately
// never asks for events outside the ABI ("an absence inferred from a request
// that was never made"), so those two are EXPECTED to be absent from the
// re-capture — the only difference the verification tolerates, and only for
// UNPARSED committed events. A parsed event going missing, or any event being
// extra, fails the capture.
const expectedUnparsed = new Set(
	committed.eventStream
		.filter((e) => e.eventName === undefined || e.decodeError !== undefined)
		.map(identityOf),
);
const unexpectedMissing = missingInRecapture.filter((k) => !expectedUnparsed.has(k));
const unparsedExpected = missingInRecapture.filter((k) => expectedUnparsed.has(k));

if (unexpectedMissing.length > 0) {
	console.log(`MISSING from the re-capture and PARSED in the committed fixture (${unexpectedMissing.length}):`);
	for (const k of unexpectedMissing.slice(0, 10)) {
		const e = committed.eventStream[committedIdentities.get(k)];
		console.log(`  ${k} address=${e.address} eventName=${e.eventName}`);
	}
	throw new Error(`re-capture is missing ${unexpectedMissing.length} parsed event(s)`);
}
if (extraInRecapture.length > 0) {
	console.log(`EXTRA in the re-capture (${extraInRecapture.length}):`);
	for (const k of extraInRecapture.slice(0, 10)) {
		const e = merged[recapturedIdentities.get(k)];
		console.log(`  ${k} address=${e.address} eventName=${e.eventName}`);
	}
	throw new Error(`re-capture has ${extraInRecapture.length} event(s) the committed fixture lacks`);
}

console.log(
	`verified against the committed fixture: all ${merged.length} re-captured identities present there; ` +
		`${unparsedExpected.length} committed event(s) absent here, all of them UNPARSED (undeclared events the ` +
		`topic0-filtered fetch no longer asks for — expected since #26/#27)`,
);

// The decoded half can DRIFT with the decoder since the original capture
// (2026-08-22, commit d635f39); compared over the events both sides hold.
let argsDrift = 0;
for (const [k, i] of recapturedIdentities) {
	const j = committedIdentities.get(k);
	if (
		JSON.stringify(merged[i].args, taggedBnReplacer) !==
			JSON.stringify(committed.eventStream[j].args, taggedBnReplacer) ||
		merged[i].eventName !== committed.eventStream[j].eventName
	) {
		argsDrift++;
	}
}
console.log(
	`args/eventName: ${argsDrift === 0 ? 'identical too' : `${argsDrift} events with decoder drift since the original capture`}`,
);

// ------------------------------------------------------------ assemble + write

if (VERIFY_ONLY) {
	console.log('verify-only: nothing written');
} else {
const fixture = {
	format: committed.format,
	provenance: {
		what: 'stratagems on Base (deployments/alpha1): Stratagems + Gems + GemsGenerator, every log in the range, BOTH the raw and the decoded half',
		deployment: 'alpha1',
		stratagemsRepo: 'github.com/wighawag/stratagems',
		stratagemsCommit: gitCommit(STRATAGEMS),
		contracts: contracts.map((c) => ({address: c.address, startBlock: c.startBlock})),
		node: new URL(url).host,
		chainHeadAtCapture: latestBlock,
		capturedBy: 'docs/spikes/replay-parse-cost/capture-full.mjs',
		captureMethod: 'one captureStream call PER CONTRACT (the merged three-contract ABI is refused by LogEventFetcher\'s ambiguity guard since #28), merged in stream order (blockNumber, then logIndex) and verified event-for-event against the committed fixture',
		companionTo: 'packages/conformance-workload-stratagems/fixtures/stratagems-alpha1.stream.json.gz (same pinned range, data/topics omitted there)',
		fromBlock: FROM_BLOCK,
		toBlock: TO_BLOCK,
		capturedAt: new Date().toISOString(),
	},
	source: fullSource,
	lastSync: {
		context: {
			source: sourceHashesOf(fullSource),
			config: simple_hash({finality: 12}),
			processor: '',
		},
		latestBlock: TO_BLOCK,
		lastFromBlock: FROM_BLOCK,
		lastToBlock: TO_BLOCK,
		unconfirmedBlocks: [],
	},
	eventStream: merged,
};

fs.mkdirSync(path.dirname(OUT), {recursive: true});
fs.writeFileSync(OUT, zlib.gzipSync(Buffer.from(serializeStreamFixture(fixture, 0))));
console.log(
	`${merged.length} events in ${((Date.now() - started) / 1000).toFixed(0)}s -> ${OUT} ` +
		`(${(fs.statSync(OUT).size / 1024 / 1024).toFixed(2)} MB gzipped)`,
);}