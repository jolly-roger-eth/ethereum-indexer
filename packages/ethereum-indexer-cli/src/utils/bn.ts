/**
 * Re-exported from the core so there is ONE definition of the `"123n"`
 * convention, and in particular one definition of the test for it.
 *
 * There used to be six copies, and all six shared a bug: they checked the first
 * and last character of a string and then called `BigInt()` on the middle, so an
 * ordinary base36 `simple_hash` digest such as `1x9tbhn` threw from inside
 * `JSON.parse`. Here that meant `keepState.fetch` reading a perfectly good
 * snapshot as corrupt and cold starting, permanently, for about 1.25% of config
 * hashes. See `ethereum-indexer/src/utils/bigint.ts`.
 */
export {bnReplacer, bnReviver, isBigIntLiteral} from 'ethereum-indexer';
