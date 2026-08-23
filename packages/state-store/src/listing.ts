import {idValues} from './entities.js';
import type {NormalizedEntity} from './types.js';

/**
 * The one SET read the entity model has, and the shape of its bound.
 *
 * `get` / `set` / `delete` are BY ID, which leaves a handler unable to ask which
 * rows belong to a parent. The cost of that hole is measured rather than
 * imagined: in `work/notes/findings/sqlite-in-the-browser.md` an ordered bounded
 * array became three entities plus a hand-maintained CSV index, and a `pop()`
 * became an O(cells x players) loop of manual deletes, on a path that ran 100
 * times on the real stream.
 *
 * The fix is the read side and nothing more, exactly as The Graph's schema
 * language solves it: a one-to-many is `@derivedFrom`, a virtual field "never
 * actually created during indexing", so children are their own entity keyed by
 * their parent and the collection is DERIVED WHEN READ.
 *
 * **The bound is the decision, not an implementation detail.** A listing takes a
 * PREFIX of the declared id and a REQUIRED limit. It takes no predicate, no
 * caller-supplied ordering and no offset, so an accidental full scan is
 * impossible to EXPRESS rather than merely discouraged, and the operation stays
 * the one shape that is a single indexed range scan on every backend: a
 * primary-key prefix scan in SQLite, an `IDBKeyRange.bound([epoch], [epoch, []])`
 * cursor in IndexedDB, a sorted walk in memory. It costs nothing at write time,
 * which is what distinguishes it from materialising counts.
 *
 * A backend with a query planner is not held to this: `@etherfold/state-store-sqlite`
 * keeps `queryCurrent` / `queryAsOf`, which do take caller-supplied SQL, because
 * that is the server-side read layer and it does not run once per event.
 */

/**
 * A PREFIX of a business key: the first K declared id columns, K >= 1.
 *
 * `{epoch: 7}` under `id: ['epoch', 'position', 'playerIndex']` is the children
 * of epoch 7. `{position: 1}` is not a prefix at all, and neither is
 * `{epoch: 7, playerIndex: 0}`: both would need a scan rather than a range.
 */
export type EntityIdPrefix = Record<string, string | number>;

/**
 * What a listing answers: the rows, and whether there were MORE.
 *
 * `truncated` is the half that could have been left out and must not be. A
 * caller cannot infer it from `rows.length === limit`, because a set that
 * exactly fills the limit is indistinguishable from one that was cut off, and a
 * handler that guesses wrong (a cascade delete that stops early, say) leaves
 * orphans behind silently. It is the same rule the rest of this seam follows: a
 * plausible wrong answer is worse than a refusal or a flag.
 */
export type Listing<T> = {
	/** At most `limit` rows, in ascending order of the declared id. */
	readonly rows: readonly T[];
	/** At least one further row matched the prefix and did not fit. */
	readonly truncated: boolean;
};

/**
 * Validate a listing prefix and return its values, in declared column order.
 *
 * The rule is one line and the error carries the whole declaration, because the
 * mistake this catches (naming the id columns out of order, or skipping one) is
 * made while reading the entity declaration in another file.
 *
 * An EMPTY prefix is refused rather than meaning "the whole entity". A listing
 * is anchored at a key by construction: unanchored, SQLite stops riding the id
 * index and sorts into a temp b-tree, which is precisely the accidental scan the
 * bound exists to make inexpressible. "The first N rows of this table" is a
 * query-planner question, and it lives above the seam.
 */
export function prefixValues(entity: NormalizedEntity, prefix: EntityIdPrefix): string[] {
	const named = Object.keys(prefix ?? {});
	const leading = entity.id.slice(0, named.length);
	if (named.length === 0 || named.length > entity.id.length || !named.every((column) => leading.includes(column))) {
		throw new Error(
			`entity ${entity.name} declares its id as (${entity.id.join(', ')}), and a listing prefix must be a ` +
				`LEADING run of at least one of those columns, in that order. Got (${named.join(', ')}). ` +
				`Valid prefixes here: ${entity.id.map((_, index) => `{${entity.id.slice(0, index + 1).join(', ')}}`).join(', ')}.`,
		);
	}
	// stringified exactly as a full id is, so `{epoch: 7}` and `{epoch: '7'}`
	// select the same children.
	return idValues({...entity, id: leading}, prefix);
}

/** Whether a full id starts with the prefix values, i.e. is one of its children. */
export function hasIdPrefix(id: readonly string[], prefix: readonly string[]): boolean {
	return prefix.every((value, index) => id[index] === value);
}

/**
 * Ascending order of the declared id: column by column, over the STRINGIFIED
 * values, which is the order a key-prefix range scan produces for free.
 *
 * It is therefore LEXICOGRAPHIC, not numeric: `'10'` sorts before `'9'`. An
 * ordered child collection whose key is a number wants a fixed-width or
 * zero-padded key (or, better, a key that is naturally ordered such as
 * `(blockNumber, logIndex)`), and that is a MODELLING answer rather than a
 * parameter, because a caller-supplied ordering is exactly what makes a scan
 * unbounded.
 */
export function compareIds(a: readonly string[], b: readonly string[]): number {
	for (let index = 0; index < Math.min(a.length, b.length); index++) {
		if (a[index] < b[index]) return -1;
		if (a[index] > b[index]) return 1;
	}
	return a.length - b.length;
}

/**
 * The limit is REQUIRED by the type and whole by this check.
 *
 * There is no default, and there deliberately never will be one: a default
 * bound is a bound nobody chose, and the first handler that outgrows it would
 * get a silently short answer.
 */
export function assertListingLimit(entity: NormalizedEntity, limit: number): void {
	if (!Number.isInteger(limit) || limit < 1) {
		throw new Error(
			`listing ${entity.name} needs a limit that is a whole number of rows, at least 1, got ${JSON.stringify(limit)}.`,
		);
	}
}

/**
 * Turn a scan of `limit + 1` rows into a `Listing` of at most `limit`.
 *
 * The extra row is the whole mechanism behind `truncated`, and it is why every
 * backend fetches one more than it was asked for: reading one further index
 * entry is what turns "there may be more" into a fact.
 */
export function boundedListing<T>(fetched: readonly T[], limit: number): Listing<T> {
	return {rows: fetched.slice(0, limit), truncated: fetched.length > limit};
}
