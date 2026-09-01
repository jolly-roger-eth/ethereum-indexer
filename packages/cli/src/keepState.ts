import {
	Abi,
	BLOB_SNAPSHOT_FORMAT,
	isReadableBlobSnapshot,
	KeepState,
	ProcessorContext,
	taggedBnReplacer,
	taggedBnReviver,
} from '@etherfold/core';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {logs} from 'named-logs';
import {contextFilenames} from '@etherfold/utils';

const logger = logs('etherfold:keepState');

/**
 * This keeper is the WRITER of the blob snapshot envelope, and the number saying
 * which encoding it wrote lives in `@etherfold/core`
 * (`BLOB_SNAPSHOT_FORMAT`), with the codec it versions.
 *
 * It used to be this module's own constant, which is why the published snapshot
 * a browser downloads went unchecked for so long: `@etherfold/browser` cannot
 * depend on this package (it must bundle for a tab), so the one reader that
 * needed the number most could not see it. It is not re-exported from here
 * either -- one constant, one home, imported by writer and readers alike.
 */

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
			let content: string;
			try {
				content = fs.readFileSync(stateFile, 'utf-8');
			} catch (err: any) {
				if (err && err.code === 'ENOENT') {
					// No snapshot yet: normal first-run / changed-context case.
					return undefined as any; // TODO fix type in KeepState to allow undefined
				}
				// File exists but could not be read (permissions, etc.): surface it instead of
				// silently treating it as a cold start.
				logger.error(`could not read snapshot at ${stateFile}, treating as no snapshot:`, err);
				return undefined as any;
			}
			try {
				const json = JSON.parse(content, taggedBnReviver);
				if (!isReadableBlobSnapshot(json)) {
					// Not this build's encoding, so its BigInts cannot be recovered here.
					// See BLOB_SNAPSHOT_FORMAT: cold starting is the honest answer.
					logger.error(
						`snapshot at ${stateFile} is format ${(json as any)?.format} and this build reads ${BLOB_SNAPSHOT_FORMAT}, treating as no snapshot`,
					);
					return undefined as any;
				}
				return {
					state: json.state,
					lastSync: json.lastSync,
					history: json.history,
				};
			} catch (err) {
				// Present-but-corrupt (e.g. truncated by an old non-atomic write or a bad commit):
				// do NOT silently swallow — log so it is diagnosable, then cold-start.
				logger.error(`snapshot at ${stateFile} is present but could not be parsed, treating as no snapshot:`, err);
				return undefined as any;
			}
		},
		save: async (context, all) => {
			const {stateFile, lastSyncFile} = filepaths(folder, context);
			const envelope = {
				format: BLOB_SNAPSHOT_FORMAT,
				processor: (all.lastSync as any)?.context?.processor,
				savedAt: new Date().toISOString(),
				lastSync: all.lastSync,
				state: all.state,
				history: all.history,
			};
			const dirname = path.dirname(stateFile);
			if (!fs.existsSync(dirname)) {
				fs.mkdirSync(dirname, {recursive: true});
			}
			// Write both files atomically (temp + rename) so an interrupted save never leaves a
			// truncated/invalid snapshot on disk.
			atomicWriteFileSync(lastSyncFile, JSON.stringify(all.lastSync, taggedBnReplacer, 2));
			atomicWriteFileSync(stateFile, JSON.stringify(envelope, taggedBnReplacer, 2));
		},
		clear: async () => {},
	};
}
