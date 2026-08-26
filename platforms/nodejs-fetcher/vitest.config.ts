import {defineConfig} from 'vitest/config';

export default defineConfig({
	test: {
		// installs the `named-logs` hook before any source module is imported, which
		// is the only point at which a hook takes effect. See the setup file.
		setupFiles: ['./test/vitest/capture-logs.ts'],
	},
});
