import * as fs from 'node:fs';
import {taggedBnReplacer, taggedBnReviver} from '@etherfold/core';

/**
 * A folder of JSON blobs, keyed by a storage id.
 *
 * BigInts go through the core's ONE codec (`taggedBnReplacer` /
 * `taggedBnReviver`), which tags them as `{__bigint__: "123"}`. This used to
 * suffix them with `n` and revive anything that read that way, which cannot tell
 * a real `uint256` from a string a contract emitted that happens to end in `n`;
 * see `@etherfold/core`'s `utils/bigint.ts`.
 *
 * A blob written under the old convention is not translated. It parses, and its
 * BigInts come back as the `"123n"` STRINGS they now are: this file carries no
 * format number to refuse on, and inventing one to reject a cache whose recovery
 * is a re-index would be more machinery than the problem. Clear the folder.
 */
export function storage(folder: string) {
	async function get<T extends any = any>(storageID: string): Promise<T | undefined> {
		let text: string | undefined;
		try {
			text = fs.readFileSync(folder + '/' + storageID + '.json', 'utf-8');
		} catch {}
		const existingState: T | undefined = text ? JSON.parse(text, taggedBnReviver) : undefined;
		return existingState;
	}

	async function set<T extends any = any>(storageID: string, data: T) {
		if (!fs.existsSync(folder)) {
			fs.mkdirSync(folder, {recursive: true});
		}
		fs.writeFileSync(folder + '/' + storageID + '.json', JSON.stringify(data, taggedBnReplacer));
	}

	async function del(storageID: string) {
		try {
			fs.unlinkSync(folder + '/' + storageID + '.json');
		} catch {}
	}

	return {get, set, del};
}
