/**
 * The stratagems state, declared as entities.
 *
 * This is the honest test of `one-processor-everywhere`'s entity model: scalars
 * plus id-reference relations, aggregations parked. Every place the shape below
 * departs from the `Data` object the real processor mutates is a contortion the
 * model forced, and each one is marked CONTORTION with what it cost.
 */
import type {EntityDeclaration} from '../../../../../packages/state-store-sqlite/dist/index.js';

/** The one row of a singleton entity. See `globalRate`. */
export const SINGLETON = {id: 'singleton'} as const;

export const stratagemsEntities: readonly EntityDeclaration[] = [
	/**
	 * `state.cells[position]`. A keyed map of flat numeric records, which is the
	 * case the model was designed for: it maps across with nothing lost.
	 */
	{
		name: 'cell',
		id: 'position',
		fields: {
			lastEpochUpdate: 'integer',
			epochWhenTokenIsAdded: 'integer',
			color: 'integer',
			life: 'integer',
			delta: 'integer',
			enemyMap: 'integer',
			distribution: 'integer',
			stake: 'integer',
			producingEpochs: 'integer',
		},
	},

	/**
	 * `state.owners[position]`.
	 *
	 * CONTORTION (minor): a map of position to a single scalar becomes a whole
	 * entity, because the model has no "scalar keyed by id" shape. Folding it
	 * into `cell` was rejected: the processor writes `owners[p]` at points where
	 * it does not write `cells[p]`, and `set` writes a WHOLE row, so folding
	 * would make an owner write silently clear the nine cell fields. That is the
	 * `set`-writes-a-row semantics doing exactly what it promises, and the cost
	 * lands as an extra entity plus a second read on every `ownerOf`.
	 */
	{
		name: 'cellOwner',
		id: 'position',
		fields: {owner: 'text'},
	},

	/** `state.commitments[account]`. Deleted on reveal/cancel/void, which `delete` covers. */
	{
		name: 'commitment',
		id: 'account',
		fields: {epoch: 'integer', hash: 'text'},
	},

	/**
	 * `state.placements[]`, an ORDERED, BOUNDED array (unshift, pop past 7).
	 *
	 * CONTORTION (major, two parts):
	 *
	 * 1. ORDER. An array's order is not a field, so it has to become one. Here
	 *    the order is arrival order (`unshift`), NOT epoch order, so it cannot be
	 *    recovered by sorting on `epoch`: the window list below records it.
	 * 2. CASCADE. Dropping the 8th-oldest entry drops the whole nested object
	 *    under it. `MutationContext` is get/set/delete BY ID with no listing, so
	 *    nothing in a handler can ask "which cells belong to epoch N". The
	 *    positions are therefore denormalised into `positions` (a CSV) purely so
	 *    the handler can walk them and delete each child by id. That is a foreign
	 *    key maintained by hand, in the direction the store cannot answer.
	 */
	{
		name: 'placement',
		id: 'epoch',
		fields: {positions: 'text'},
	},

	/**
	 * `state.placements[i].cells[position]`, whose value is `{players: [...]}`.
	 *
	 * CONTORTION: `playerCount` is a COUNT, which is precisely the aggregation
	 * the spec parks. It is not decoration: without it the next `players.push`
	 * has no index to write at and no reader can tell where the list ends.
	 */
	{
		name: 'placementCell',
		id: ['epoch', 'position'],
		fields: {playerCount: 'integer'},
	},

	/**
	 * `state.placements[i].cells[position].players[index]`.
	 *
	 * CONTORTION: an ordered inner array becomes an entity whose id carries its
	 * own array index. Appending is read-count, write-at-count, write-count-plus-one,
	 * so one `push` is three round-trips instead of one.
	 *
	 * The column is `playerIndex`, not the obvious `index`, and that is NOT a
	 * style choice: `index` passes `@etherfold/state-store-sqlite`'s identifier
	 * validation (it matches the regex and does not start with `_`) and then
	 * produces `near "index": syntax error` when `migrate()` runs, because
	 * identifiers are interpolated into DDL unquoted and `INDEX` is a SQL
	 * keyword. The in-memory and IndexedDB backends accept it happily. So the
	 * same declaration is valid on one backend and fatal on another, and the
	 * failure surfaces at migration rather than at declaration.
	 */
	{
		name: 'placementPlayer',
		id: ['epoch', 'position', 'playerIndex'],
		fields: {color: 'integer', address: 'text'},
	},

	/**
	 * The ordered, bounded window over `placement`.
	 *
	 * CONTORTION: this entity exists ONLY because the model cannot express "the
	 * seven most recent, in arrival order". It is a singleton holding a CSV of
	 * epochs. A store with a list/query surface would not need it, and the entity
	 * is pure index: it has no counterpart anywhere in the processor's state.
	 */
	{
		name: 'placementWindow',
		id: 'id',
		fields: {epochs: 'text'},
	},

	/**
	 * `state.points.global`, a SINGLETON.
	 *
	 * CONTORTION (minor): every entity is keyed, so a value that exists once gets
	 * an invented id (`'singleton'`). Harmless, and it is what the subgraph model
	 * does too.
	 *
	 * CONTORTION (real): `totalRewardPerPointAtLastUpdate` and `totalPoints` are
	 * `uint256`. The declarable column types are text/integer/real/blob, and
	 * SQLite's INTEGER is 64-bit, so a u256 has to be TEXT and every read has to
	 * `BigInt()` it back. Equality then depends on the encoding being canonical
	 * (no leading zeros, decimal, never hex), which is a rule nothing in the
	 * model states or enforces.
	 */
	{
		name: 'globalRate',
		id: 'id',
		fields: {
			lastUpdateTime: 'integer',
			totalRewardPerPointAtLastUpdate: 'text',
			totalPoints: 'text',
		},
	},

	/** `state.points.fixed[account]`. `toWithdraw` is a u256, so TEXT (see above). */
	{
		name: 'fixedRate',
		id: 'account',
		fields: {toWithdraw: 'text', lastTime: 'integer'},
	},

	/** `state.points.shared[account]`. Three u256s, so three TEXT columns. */
	{
		name: 'sharedRate',
		id: 'account',
		fields: {
			points: 'text',
			totalRewardPerPointAccounted: 'text',
			rewardsToWithdraw: 'text',
		},
	},

	/**
	 * `state.computedPoints[player]`, a DERIVED accumulator.
	 *
	 * No contortion, and worth saying so: read-then-add-then-write is exactly
	 * what `update` sugar is for, and read-your-writes inside a block is what
	 * makes two `addPoints` calls in one block compose. This is the case the
	 * spec's user story 5 is about, and it works.
	 */
	{
		name: 'computedPoints',
		id: 'owner',
		fields: {points: 'integer'},
	},
];
