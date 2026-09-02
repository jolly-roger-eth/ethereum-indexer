import type {RetentionSetting} from '@etherfold/processor-entities';
import type {Options, ResolvedOptions, StoreTarget} from './types.js';

/**
 * Read the flags into the ONE decision this command owns: where the state goes.
 *
 * ## Why `--store` survives with a single value
 *
 * It named two stores -- `file`, a free-form state blob with no history, and
 * `sqlite`, versioned rows -- until the blob went with the processor path that
 * wrote it (ADR-0037). What is left is one value, and the flag is kept, still
 * required and still not defaulted, because it is the AXIS a second backend
 * arrives on rather than a leftover: the value an operator types is the same
 * word before and after one appears, and a run that wrote a database nobody
 * named would be the thing this command has never done.
 *
 * ## Why a wrong combination is REFUSED and never ignored
 *
 * An accepted-and-ignored flag is a deployment believing something that is not
 * true -- a retention window nothing enforces, a database nothing writes -- so a
 * value that names no store is refused rather than shrugged at.
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
			`--store is required, and names where the indexed state goes: 'sqlite' keeps versioned entity rows in a ` +
				`libSQL database (--db).`,
		);
	}

	if (options.store === 'sqlite') {
		if (options.db === undefined) {
			throw new Error(
				`--store sqlite writes to a libSQL database, so --db <url> is required with it, e.g. ` +
					`--db file:./etherfold.db or --db libsql://<host>. It is not defaulted, so no run ever writes a ` +
					`database nobody named.`,
			);
		}
		return {store: 'sqlite', db: options.db, retention: parseRetention(options.retention)};
	}

	throw new Error(`--store ${JSON.stringify(options.store)} is not a store. It is 'sqlite'.`);
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
