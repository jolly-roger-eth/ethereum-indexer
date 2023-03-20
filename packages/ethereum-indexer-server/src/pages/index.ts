import path from 'path';
import fs from 'fs';

import {dirname} from 'path';
import {fileURLToPath} from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function page(name: string): string {
	return fs.readFileSync(path.join(__dirname, '../templates', name), 'utf-8');
}

export const adminPage = page('admin.html');
