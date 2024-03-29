import path from 'path';
import fs from 'fs';

import {dirname} from 'path';
import {fileURLToPath} from 'url';

const _dirname = typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));

function page(name: string): string {
	return fs.readFileSync(path.join(_dirname, '../templates', name), 'utf-8');
}

export const adminPage = page('admin.html');
