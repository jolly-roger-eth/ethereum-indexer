/**
 * Does the port's trace actually apply to the REAL versioned SQLite store, and
 * does that store then answer the same reads the in-memory reference does?
 *
 *   npx tsx run/verify-store.ts
 *
 * This runs in node against libSQL, which is the same SQL the browser's wasm
 * SQLite will run. It is the cheap place to find out that a mutation shape the
 * processor emits is one the store cannot take: finding that in a browser
 * worker costs an hour, finding it here costs a second.
 *
 * It also checks the two things the spec's second open question rests on:
 * an as-of read at depth, and a revert that has to make a counter DECREASE.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createClient} from '@libsql/client';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {blocksOf} from '../../../../packages/core/dist/index.js';
import {loadStreamFixture} from '../../../../packages/fs/dist/index.js';
import {MemoryBlockStore} from '../src/store/memory.js';
import {VersionedSqlBlockStore} from '../src/store/versioned-sql.js';
import {runPortOverBlocks} from '../src/port/run-port.js';
import {generateEventStream, WORKLOAD_SIZES} from '../src/workload/generate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(HERE, '../results');

// The REAL launched game by default; `npx tsx run/verify-store.ts synthetic` runs
// the generated stream instead, which is the only one that reaches
// `onForceSimpleCells`.
const useSynthetic = process.argv[2] === 'synthetic';
const blocks = useSynthetic
	? generateEventStream({...WORKLOAD_SIZES.small, seed: 42, includeRewards: true, includeForceCells: true})
	: (blocksOf(loadStreamFixture(path.join(HERE, '../../../../packages/conformance-workload-stratagems/fixtures/stratagems-alpha1.stream.json.gz'))) as any[]);

// The trace, recorded once by the port against the in-memory reference.
const reference = new MemoryBlockStore({kind: 'unbounded'});
await reference.open();
const run = await runPortOverBlocks(reference, blocks as any);

// The same trace, applied to the real versioned SQLite store.
const db = new RemoteLibSQL(createClient({url: ':memory:'}));
const sql = new VersionedSqlBlockStore('libsql', db as any, {kind: 'unbounded'});
await sql.open();
const started = Date.now();
for (const update of run.trace) {
	await sql.applyBlock(update);
}
const applyMs = Date.now() - started;

// Every live row must read back identically through both.
let checked = 0;
const mismatches: string[] = [];
for (const row of reference.liveRows()) {
	const id: Record<string, string> = {};
	for (const part of row.id.split('|')) {
		const [name, ...rest] = part.split('=');
		id[name] = rest.join('=');
	}
	const fromSql = await sql.get(row.entity, id);
	checked++;
	if (!fromSql) {
		mismatches.push(`${row.entity} ${row.id}: missing from SQLite`);
		continue;
	}
	for (const [field, value] of Object.entries(row.values)) {
		if (String(fromSql[field]) !== String(value)) {
			mismatches.push(`${row.entity} ${row.id}.${field}: memory=${value} sqlite=${fromSql[field]}`);
		}
	}
	if (mismatches.length > 20) break;
}

// An as-of read at depth, and a revert that must make a counter go DOWN.
const tip = run.trace[run.trace.length - 1].block.number;
const mid = run.trace[Math.floor(run.trace.length / 2)].block.number;
const someCounter = reference.liveRows().find((row) => row.entity === 'computedPoints');
const asOfAgreement: string[] = [];
if (someCounter) {
	const id = {owner: someCounter.id.replace('owner=', '')};
	const memoryAsOf = await reference.getAsOf('computedPoints', id, mid);
	const sqlAsOf = await sql.getAsOf('computedPoints', id, mid);
	if (String(memoryAsOf?.points) !== String(sqlAsOf?.points)) {
		asOfAgreement.push(`as of ${mid}: memory=${memoryAsOf?.points} sqlite=${sqlAsOf?.points}`);
	}
	const atTip = Number((await sql.get('computedPoints', id))?.points ?? 0);
	await sql.revertTo(mid);
	const afterRevert = Number((await sql.get('computedPoints', id))?.points ?? 0);
	await reference.revertTo(mid);
	const referenceAfterRevert = Number((await reference.get('computedPoints', id))?.points ?? 0);
	if (afterRevert !== referenceAfterRevert) {
		asOfAgreement.push(`after revert to ${mid}: memory=${referenceAfterRevert} sqlite=${afterRevert}`);
	}
	console.log(
		`counter ${JSON.stringify(id)}: ${atTip} at tip ${tip}, ` +
			`${String(memoryAsOf?.points)} as of ${mid}, ${afterRevert} after reverting to ${mid}`,
	);
}

const result = {
	workload: useSynthetic ? 'generated small' : 'real: stratagems alpha1 on Base',
	blocks: run.trace.length,
	mutations: run.trace.reduce((sum, update) => sum + update.mutations.length, 0),
	rowsChecked: checked,
	mismatches,
	asOfDisagreements: asOfAgreement,
	applyMsLibsqlInNode: applyMs,
	ranAt: new Date().toISOString(),
};
fs.mkdirSync(RESULTS, {recursive: true});
fs.writeFileSync(
	path.join(RESULTS, `store-agreement${useSynthetic ? '-synthetic' : ''}.json`),
	JSON.stringify(result, null, 2),
);

console.log(`applied ${result.blocks} blocks (${result.mutations} mutations) to libSQL in ${applyMs} ms`);
console.log(`checked ${checked} live rows: ${mismatches.length} mismatches, ${asOfAgreement.length} as-of/revert disagreements`);
for (const line of [...mismatches.slice(0, 10), ...asOfAgreement]) console.log('  ' + line);
process.exit(mismatches.length === 0 && asOfAgreement.length === 0 ? 0 : 1);
