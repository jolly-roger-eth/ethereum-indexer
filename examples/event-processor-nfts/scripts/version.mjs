import * as fs from 'fs';
import * as crypto from 'crypto';

const outDir = 'dist';

function transform(filepath, versionHash) {
	const content = fs.readFileSync(filepath, 'utf-8');
	const hash = versionHash || crypto.createHash('sha256').update(content, 'utf8').digest('hex');
	fs.writeFileSync(filepath, content.replace('__VERSION_HASH__', hash));
	return hash;
}

const entry = `${outDir}/index.js`;
const hash = transform(entry);

for (const f of [`${outDir}/index.cjs`, `${outDir}/index.d.ts`]) {
	if (fs.existsSync(f)) transform(f, hash);
}
