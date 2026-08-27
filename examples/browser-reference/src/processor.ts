import type {EntityProcessor} from '@etherfold/processor-entities';

/**
 * ONE contract, ONE event, ONE processor. The whole subject of the reference.
 *
 * A counter contract, because the interesting parts of this example are not in
 * the reducer: what matters is that `transfers` is a number a HANDLER decides,
 * so "did the edited logic take effect" and "was the old state thrown away" are
 * both answerable by reading it.
 */

export const abi = [
	{
		type: 'event',
		name: 'Transfer',
		anonymous: false,
		inputs: [
			{indexed: true, name: 'from', type: 'address'},
			{indexed: true, name: 'to', type: 'address'},
			{indexed: false, name: 'id', type: 'uint256'},
		],
	},
] as const;

export type TokenABI = typeof abi;

/**
 * The version is REQUIRED, and it is the single most consequential string in
 * this file.
 *
 * `getVersionHash()` is `${version}-${hash({entities, config})}`. Handler code is
 * in NONE of those, so the core cannot see that you edited a handler. Editing
 * the reducer below and leaving this alone means a hot reload SKIPS the swap and
 * your edit never runs -- see `browser/main.ts`, "axis one".
 *
 * Generate it if you can (a content hash, a build id, a git sha) so it cannot be
 * forgotten. `import.meta.env` is available in Vite and is one way:
 *
 *     version: import.meta.env.DEV ? `dev-${Date.now()}` : '1.0.0'
 *
 * That is not done here because it would make every reload discard the state,
 * which would hide the very behaviour this example exists to show.
 */
export const PROCESSOR_VERSION = '1.0.0';

export const tokenProcessor: EntityProcessor<TokenABI> = {
	version: PROCESSOR_VERSION,
	entities: [
		{name: 'token', id: ['id'], fields: {owner: 'text'}},
		{name: 'counter', id: ['name'], fields: {value: 'integer'}},
	],
	async onTransfer(state, event) {
		state.set('token', {id: event.args.id.toString()}, {owner: event.args.to});
		const counter = await state.get<{value: number}>('counter', {name: 'transfers'});
		state.set('counter', {name: 'transfers'}, {value: (counter?.value ?? 0) + 1});
	},
};
