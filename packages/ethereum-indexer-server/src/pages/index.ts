import path from 'path';
import fs from 'fs';

function page(name: string): string {
	return fs.readFileSync(path.join(__dirname, '../templates', name), 'utf-8');
}

export const adminPage = page('admin.html');
