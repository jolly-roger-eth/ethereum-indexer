import {expect} from 'vitest';
import {RESERVED_WORDS, block, cases, opened, ordered} from '../fixtures.js';
import type {ConformanceCase, StateStoreFactory} from '../types.js';

const GROUP = 'a declaration means the same thing on every backend';

/**
 * The entity declaration is PORTABLE: whether a declaration is legal is a fact
 * about the declaration, never about the backend it lands on.
 *
 * This is the group that makes `{name, id, fields}` a shared surface rather than
 * a shape each backend interprets. One processor writes one set of declarations
 * and several backends store them, so a name accepted here and fatal there makes
 * that processor silently non-portable, and it fails at DEPLOY time on one
 * platform rather than where it was written.
 *
 * The real instance is a SQL keyword. `work/notes/findings/sqlite-in-the-browser.md`
 * records an id column named `index` passing validation, being stored without
 * complaint by the light and IndexedDB backends, and then killing `migrate()` on
 * SQLite with `SQLITE_ERROR: near "index": syntax error`: SQL cannot bind an
 * identifier as a parameter, so a name reaches the engine as TEXT, and `index`
 * has a perfectly valid identifier shape while being a keyword. `RESERVED` (the
 * `order` fixture) is spelled entirely in such keywords, so every backend is
 * asked the same question with the same declaration.
 *
 * Both directions are asserted, because both are the same property. A name every
 * backend accepts must WORK everywhere, and a name any backend refuses must be
 * refused everywhere, at DECLARATION time -- which is what the store's `_`
 * namespace is, and the reason it is checked here and not only where it is
 * enforced.
 */
export function portableDeclarationCases(factory: StateStoreFactory): ConformanceCase[] {
	return cases(GROUP, {
		'an entity whose name, id columns and fields are SQL keywords migrates': async () => {
			// `opened` migrates, which is where the SQL backends used to die.
			const store = await opened(factory);

			expect(RESERVED_WORDS.length).toBeGreaterThan(0);
			expect(await store.getCurrent('order', {group: 'a', index: 1})).toBeUndefined();
		},

		'a keyword id column and a keyword field round-trip through a write': async () => {
			const store = await opened(factory);
			await store.applyBlock(block(100), [ordered('a', 1, 'first')]);

			expect(await store.getCurrent('order', {group: 'a', index: 1})).toMatchObject({
				select: 'first',
				table: 'ledger',
				where: 1,
				default: 'none',
				references: 'a',
				primary: 'a/1',
			});
		},

		'a listing over a keyword id prefix returns its children in order': async () => {
			const store = await opened(factory);
			await store.applyBlock(block(100), [
				ordered('a', 2, 'second'),
				ordered('a', 1, 'first'),
				ordered('b', 1, 'other'),
			]);

			const listed = await store.listCurrent<{select: string}>('order', {group: 'a'}, 10);
			expect(listed.rows.map((row) => row.select)).toEqual(['first', 'second']);
			expect(listed.truncated).toBe(false);
		},

		'a keyword entity is reverted like any other': async () => {
			const store = await opened(factory);
			await store.applyBlock(block(100), [ordered('a', 1, 'first')]);
			await store.applyBlock(block(101), [ordered('a', 1, 'second')]);

			await store.revertTo(100);
			expect(await store.getCurrent('order', {group: 'a', index: 1})).toMatchObject({select: 'first'});
		},

		'the store `_` namespace is refused at DECLARATION time, everywhere': async () => {
			// the other half of the same property: a declaration one backend refuses
			// must be refused by all of them, and refused where it was written rather
			// than at the first statement that would have collided with a version
			// column. `Promise.resolve().then` so a factory that throws synchronously
			// and one that rejects are asserted the same way.
			await expect(
				Promise.resolve().then(() => factory([{name: 'token', id: ['id'], fields: {_lower: 'integer'}}])),
			).rejects.toThrow(/reserved/i);

			await expect(Promise.resolve().then(() => factory([{name: '_secret', id: ['id'], fields: {}}]))).rejects.toThrow(
				/reserved/i,
			);
		},

		'a name that is not an identifier at all is refused at DECLARATION time, everywhere': async () => {
			await expect(Promise.resolve().then(() => factory([{name: 'to"ken', id: ['id'], fields: {}}]))).rejects.toThrow(
				/identifier/i,
			);

			await expect(
				Promise.resolve().then(() => factory([{name: 'token', id: ['id'], fields: {'a-b': 'text'}}])),
			).rejects.toThrow(/identifier/i);
		},
	});
}
