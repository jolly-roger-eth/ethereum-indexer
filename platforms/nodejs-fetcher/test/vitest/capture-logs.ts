import {hook} from 'named-logs';

/**
 * Capture every line the shipped code logs, through the real `named-logs` path.
 *
 * It has to happen in a SETUP file rather than inside a test: `logs(namespace)`
 * resolves the factory when the module calling it is first imported, so a hook
 * installed after that import gets nothing. Setup files run before the test
 * module graph, which is the only moment this works from.
 *
 * What it is for: `loop.test.ts` asserts that no credential is ever written, and
 * an assertion about logging that does not read the real logger is an assertion
 * about a mock.
 */
declare global {
	// eslint-disable-next-line no-var
	var __logLines: string[];
}

globalThis.__logLines = [];

hook((namespace: string) => {
	const capture =
		(level: string) =>
		(...data: unknown[]) =>
			globalThis.__logLines.push(`${level} ${namespace} ${data.map((entry) => String(entry)).join(' ')}`);
	return new Proxy({}, {get: (_target, property: string) => capture(property)}) as never;
});
