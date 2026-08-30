/**
 * The filesystem port, mirroring `packages/fs/src/utils/fs.ts`.
 *
 * Deliberately the SAME shape as the real keeper — a folder of JSON blobs, read
 * and written with the SYNC calls wrapped in async functions — so what is
 * measured is this repo's filesystem keeper rather than an idealised one. Two
 * things are ADDED, and they are the three lines the design record says a
 * `readdir` is away:
 *
 *   keys()    a `readdir`, which is what makes enumeration possible at all
 *   rename()  a native rename, which is the whole key-label arm
 *
 * `packages/fs/src/utils/fs.ts` exposes only `get`/`set`/`del` because that is
 * all it has needed.
 */
import * as fs from 'node:fs';
import type {StorePort} from './layouts.js';

/** What the substrate actually did, counted at the syscall rather than inferred. */
export type FsCounters = {
	renames: number;
	reads: number;
	writes: number;
	unlinks: number;
	bytesRead: number;
	bytesWritten: number;
};

export function fsPort(folder: string): StorePort & {counters: FsCounters; resetCounters(): void} {
	fs.mkdirSync(folder, {recursive: true});
	const counters: FsCounters = {renames: 0, reads: 0, writes: 0, unlinks: 0, bytesRead: 0, bytesWritten: 0};
	const pathOf = (id: string) => `${folder}/${id}.json`;

	return {
		counters,
		resetCounters() {
			counters.renames = 0;
			counters.reads = 0;
			counters.writes = 0;
			counters.unlinks = 0;
			counters.bytesRead = 0;
			counters.bytesWritten = 0;
		},

		async keys() {
			return fs
				.readdirSync(folder)
				.filter((f) => f.endsWith('.json'))
				.map((f) => f.slice(0, -'.json'.length));
		},

		async get(key) {
			let text: string | undefined;
			try {
				text = fs.readFileSync(pathOf(key), 'utf-8');
			} catch {
				return undefined;
			}
			counters.reads += 1;
			counters.bytesRead += text.length;
			return JSON.parse(text);
		},

		async set(key, value) {
			const text = JSON.stringify(value);
			fs.writeFileSync(pathOf(key), text);
			counters.writes += 1;
			counters.bytesWritten += text.length;
		},

		async del(key) {
			try {
				fs.unlinkSync(pathOf(key));
				counters.unlinks += 1;
			} catch {}
		},

		/**
		 * The operation the whole key-label arm rests on.
		 *
		 * Within one directory this is a directory-entry update: no file content is
		 * read, moved or rewritten, whatever the file's size. Note it is not
		 * `fsync`ed, and neither is `set` — that matches the real keeper, which does
		 * not fsync either, so both arms are measured under the same durability.
		 * With `fsync` the gap between them would only widen, since a rename dirties
		 * one directory block and a rewrite dirties the whole file.
		 */
		async rename(from, to) {
			fs.renameSync(pathOf(from), pathOf(to));
			counters.renames += 1;
		},
	};
}
