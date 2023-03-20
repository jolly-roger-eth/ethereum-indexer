import {defineConfig} from 'tsup';
import fs from 'fs-extra';

const outDir = 'dist';

export default defineConfig({
	outDir,
	async onSuccess() {
		fs.copySync('templates/', 'dist/');
	},
});
