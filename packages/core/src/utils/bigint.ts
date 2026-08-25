/**
 * ## The `"123n"` convention, and the one test it kept getting wrong
 *
 * Several storage adapters persist BigInts by suffixing them with `n` and revive
 * them by spotting that suffix. Every copy of that check (there were six, in the
 * CLI, both browser adapters, the fs adapter, `db-utils` and a dead one in the
 * js-processor) tested the FIRST and LAST character and then called `BigInt()`
 * on everything in between:
 *
 * ```ts
 * v.startsWith('-') ? !isNaN(parseInt(v.charAt(1))) : !isNaN(parseInt(v.charAt(0))) && v.endsWith('n')
 * ```
 *
 * That admits `1x9tbhn`, which is not a BigInt literal, it is an ordinary base36
 * `simple_hash` digest, and a persisted `LastSync` is largely made of those
 * (`context.processor`, `context.config`, `context.source[].hash`).
 * `BigInt('1x9tbh')` throws, and it throws inside `JSON.parse`, so a caller with
 * a `try/catch` around the parse (the CLI has one) reads a perfectly good
 * snapshot as corrupt and cold starts, permanently, blaming the file. About
 * 1.25% of digests have that shape, so it was a permanent failure for an unlucky
 * config rather than an intermittent one. The copies WITHOUT a `try/catch`
 * simply threw.
 *
 * The check is therefore the whole value, and it lives here so there is one of
 * it. This does not make the convention sound: it still cannot tell a real
 * BigInt from a string a contract emitted that happens to read like one, which
 * is why `@etherfold/processor-sqlite` tags its BigInts instead of
 * suffixing them. It only stops the guess from throwing on values that were
 * never numbers.
 */
const BIGINT_LITERAL = /^-?\d+n$/;

/** Whether a value is the string form this repo's storage adapters write BigInts as. */
export function isBigIntLiteral(value: unknown): value is string {
	return typeof value === 'string' && BIGINT_LITERAL.test(value);
}

/** `JSON.stringify` replacer: BigInt out as `"123n"`. */
export function bnReplacer(key: string, value: any): any {
	return typeof value === 'bigint' ? `${value}n` : value;
}

/** `JSON.parse` reviver: `"123n"` back to a BigInt, and nothing else touched. */
export function bnReviver(key: string, value: any): any {
	return isBigIntLiteral(value) ? BigInt(value.slice(0, -1)) : value;
}

/**
 * The TAG the sound convention uses, and the one to reach for when the strings
 * being encoded are not ours.
 *
 * The `"123n"` pair above cannot tell a real BigInt from a string a contract
 * emitted that happens to read like one, so reviving with it silently rewrites
 * event data. That is tolerable for a `LastSync` full of digests we produced and
 * intolerable for a decoded log, whose `args` are whatever the chain said. So
 * anything carrying EVENT DATA -- the sync cursor a store persists
 * (`@etherfold/processor-entities`), and the wire batches a log-fetcher pushes
 * (`serializeWireBatch`) -- tags instead, and an object with this single key
 * cannot be produced by accident.
 *
 * Both conventions exist on purpose and neither is a migration of the other: the
 * suffix one describes data ALREADY PERSISTED by this repo's storage adapters
 * and cannot be changed without rewriting it.
 */
const BIGINT_TAG = '__bigint__';

/**
 * `JSON.stringify` replacer: BigInt out as `{__bigint__: "123"}`.
 *
 * Reads the RAW value off `this` rather than trusting the `value` argument,
 * which `JSON.stringify` has already passed through any `toJSON` on the way in.
 * Without that, a BigInt nested under an object with a `toJSON` is invisible
 * here and throws inside the stringify instead.
 */
export function taggedBnReplacer(this: unknown, key: string, value: any): any {
	const raw = (this as Record<string, unknown>)?.[key];
	if (typeof raw === 'bigint') return {[BIGINT_TAG]: raw.toString()};
	return value;
}

/** `JSON.parse` reviver: `{__bigint__: "123"}` back to a BigInt, and nothing else touched. */
export function taggedBnReviver(key: string, value: any): any {
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		const keys = Object.keys(value);
		if (keys.length === 1 && keys[0] === BIGINT_TAG) {
			const text = (value as Record<string, unknown>)[BIGINT_TAG];
			if (typeof text === 'string') return BigInt(text);
		}
	}
	return value;
}
