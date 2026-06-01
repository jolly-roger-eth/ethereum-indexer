import {Abi, KeepState, ProcessorContext} from 'ethereum-indexer';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {contextFilenames} from 'ethereum-indexer-utils';
import {bnReplacer, bnReviver} from './utils/bn.js';

export function filepaths(folder: string, context: ProcessorContext<Abi, any>) {
	const {stateFile, lastSyncFile} = contextFilenames(context);
	return {stateFile: path.join(folder, stateFile), lastSyncFile: path.join(folder, lastSyncFile)};
}

// Atomically write `content` to `destFile`: write to a temp file in the SAME directory (so the
// rename stays on the same filesystem and is atomic on POSIX), fsync, then rename over the
// destination. If anything fails mid-write the destination is left untouched (the previous valid
// file survives) and the temp file is cleaned up. This prevents a killed/interrupted process from
// leaving a truncated, invalid-JSON snapshot on disk (which CI could otherwise commit and publish).
function atomicWriteFileSync(destFile: string, content: string) {
	const tmpFile = `${destFile}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
	try {
		const fd = fs.openSync(tmpFile, 'w');
		try {
			fs.writeFileSync(fd, content);
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		fs.renameSync(tmpFile, destFile);
	} catch (err) {
		try {
			if (fs.existsSync(tmpFile)) {
				fs.unlinkSync(tmpFile);
			}
		} catch {
			// ignore cleanup failure; surface the original error
		}
		throw err;
	}
}

// File-backed `keepState` implementation used by the CLI to persist/restore the processor state
// (the snapshot written to `folder` and later resumed from / committed by CI).
export function createFileKeepState<ABI extends Abi>(folder: string): KeepState<ABI, any, {history: any}, any> {
	return {
		fetch: async (context: ProcessorContext<ABI, any>) => {
			const {stateFile} = filepaths(folder, context);
			try {
				const content = fs.readFileSync(stateFile, 'utf-8');
				const json = JSON.parse(content, bnReviver);
				return {
					state: json.state,
					lastSync: json.lastSync,
					history: json.history,
				};
			} catch {
				return undefined as any; // TODO fix type in KeepState to allow undefined
			}
		},
		save: async (context, all) => {
			const {stateFile, lastSyncFile} = filepaths(folder, context);
			const data = {lastSync: all.lastSync, state: all.state, history: all.history};
			const dirname = path.dirname(stateFile);
			if (!fs.existsSync(dirname)) {
				fs.mkdirSync(dirname, {recursive: true});
			}
			// Write both files atomically (temp + rename) so an interrupted save never leaves a
			// truncated/invalid snapshot on disk.
			atomicWriteFileSync(lastSyncFile, JSON.stringify(data.lastSync, bnReplacer, 2));
			atomicWriteFileSync(stateFile, JSON.stringify(data, bnReplacer, 2));
		},
		clear: async () => {},
	};
}
