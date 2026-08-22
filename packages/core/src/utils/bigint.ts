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
