import {defineConfig} from 'tsup';
import fs from 'fs-extra';

const outDir = 'dist';

export default defineConfig({
	outDir,
	sourcemap: true,
	async onSuccess() {
		fs.copySync('templates/', 'dist/');
	},

	// from https://github.com/evanw/esbuild/issues/1492#issuecomment-893144483
	// to allow the use of import.meta.url in cjs
	inject: ['./import-meta-url.js'],
	define: {
		'import.meta.url': 'import_meta_url',
	},
});
