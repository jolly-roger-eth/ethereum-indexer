import type {RetentionSetting} from '@etherfold/processor-entities';
import type {Options, ResolvedOptions, StoreTarget} from './types.js';

/**
 * Read the flags into the ONE decision this command owns: where the state goes.
 *
 * ## Why `--store` is required rather than defaulted
 *
 * The two answers are not interchangeable. `file` keeps a free-form state blob
 * with no history: it cannot answer an as-of read and it cannot revert. `sqlite`
 * keeps versioned rows that do both, and holds the sync cursor in the same
 * transaction as the block it describes (ADR-0027). A default would make that
 * difference invisible at exactly the moment a deployment is choosing it, so
 * there is none.
 *
 * ## Why every wrong combination is REFUSED and never ignored
 *
 * `--folder` used to be a `requiredOption` feeding exactly one call
 * (`createFileKeepState`), which is meaningless on the entity path; `--db` is
 * meaningless on the file path, and `--retention` is meaningless where there is
 * no history to retain. An accepted-and-ignored flag is a deployment believing
 * something that is not true -- a retention window nothing enforces, a database
 * nothing writes -- so each one names the store it belongs to instead.
 */
export function resolveIndexOptions(options: Options): ResolvedOptions {
	return {
		processor: options.processor,
		nodeUrl: options.nodeUrl,
		...(options.deployments === undefined ? {} : {deployments: options.deployments}),
		...(options.rps === undefined ? {} : {rps: options.rps}),
		target: resolveStoreTarget(options),
	};
}

function resolveStoreTarget(options: Options): StoreTarget {
	if (options.store === undefined) {
		throw new Error(
			`--store is required, and names where the indexed state goes: 'file' keeps a free-form state blob in a ` +
				`folder (--folder), 'sqlite' keeps versioned entity rows in a libSQL database (--db). It is not ` +
				`defaulted, because the two are not interchangeable: only one of them can answer a historical read or ` +
				`survive a reorg, and a default would hide that at the moment a deployment picks.`,
		);
	}

	if (options.store === 'file') {
		refuse(
			options.db !== undefined,
			`--db names a libSQL database, which --store file does not have. Use --store sqlite.`,
		);
		refuse(
			options.retention !== undefined,
			`--retention bounds how far back superseded VERSIONS are kept, and --store file keeps a single state blob ` +
				`with no versions. Use --store sqlite.`,
		);
		if (options.folder === undefined) {
			throw new Error(`--store file writes the state to a folder, so -f, --folder <path> is required with it.`);
		}
		return {store: 'file', folder: options.folder};
	}

	if (options.store === 'sqlite') {
		refuse(
			options.folder !== undefined,
			`-f, --folder is where the free-form state FILE goes, and --store sqlite keeps the state (and its sync ` +
				`cursor) in the database named by --db. Use --store file.`,
		);
		if (options.db === undefined) {
			throw new Error(
				`--store sqlite writes to a libSQL database, so --db <url> is required with it, e.g. ` +
					`--db file:./etherfold.db or --db libsql://<host>. It is not defaulted, so no run ever writes a ` +
					`database nobody named.`,
			);
		}
		return {store: 'sqlite', db: options.db, retention: parseRetention(options.retention)};
	}

	throw new Error(`--store ${JSON.stringify(options.store)} is not a store. It is 'file' or 'sqlite'.`);
}

/**
 * A retention SETTING from a string, in the one unit retention has.
 *
 * ADR-0019: retention is a distance in BLOCK NUMBERS and in no other unit, so a
 * bare number is blocks and anything that looks like a duration is refused
 * rather than interpreted. The two named ends are the store's own words
 * (`RetentionSetting`), spelled the same on the command line so an operator
 * reading the capability report back sees what they typed.
 *
 * Default `unbounded`, which is the store's default too: it is the only setting
 * that changes nothing about a store nobody configured.
 */
function parseRetention(value: string | undefined): RetentionSetting {
	if (value === undefined || value === 'unbounded') return 'unbounded';
	if (value === 'revert-only') return 'revert-only';
	if (/^\d+$/.test(value)) {
		return {blocks: Number(value)};
	}
	throw new Error(
		`--retention ${JSON.stringify(value)} is not a retention. It is a number of BLOCKS (e.g. --retention 50000), ` +
			`'revert-only' (keep only what a reorg revert needs) or 'unbounded' (the default). A duration is refused ` +
			`because it would prune on wall-clock progress rather than on chain progress (ADR-0019).`,
	);
}

function refuse(condition: boolean, message: string): void {
	if (condition) throw new Error(message);
}
