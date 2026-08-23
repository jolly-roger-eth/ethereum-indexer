/**
 * A database name no other test is using.
 *
 * Every conformance case gets a fresh store from the factory, and on this
 * backend "fresh" means a database of its own: two stores sharing a name are ONE
 * store, which is the property the multi-tab test exists to exercise and the
 * last thing an isolated case wants.
 */
let counter = 0;

export function freshDatabaseName(prefix = 'etherfold-test'): string {
	counter++;
	return `${prefix}-${counter}-${Math.random().toString(36).slice(2, 10)}`;
}
