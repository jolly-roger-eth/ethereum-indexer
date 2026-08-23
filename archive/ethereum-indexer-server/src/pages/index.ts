import path from 'node:path';
import fs from 'node:fs';

import {dirname} from 'path';
import {fileURLToPath} from 'url';

const _dirname = typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));

function page(name: string): string {
	// In the built layout templates are copied next to the compiled output (dist/templates), so
	// `../templates` resolves from dist/pages. When running from source (e.g. tests) they live at
	// the package root, so fall back to `../../templates`.
	const candidates = [path.join(_dirname, '../templates', name), path.join(_dirname, '../../templates', name)];
	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) {
			return fs.readFileSync(candidate, 'utf-8');
		}
	}
	// preserve the original error shape if neither exists
	return fs.readFileSync(candidates[0], 'utf-8');
}

// Read lazily so merely importing this module (or anything that re-exports it) does not perform a
// filesystem read at import time.
let _adminPage: string | undefined;
export function getAdminPage(): string {
	if (_adminPage === undefined) {
		_adminPage = page('admin.html');
	}
	return _adminPage;
}
