import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import {parseStreamFixture, serializeStreamFixture, type StreamFixture} from '@etherfold/core';
import type {Abi} from '@etherfold/core';

/**
 * A fixture of a real chain is LARGE, and it is meant to be committed.
 *
 * A `.gz` path is therefore gzipped on write and gunzipped on read, chosen by
 * the extension so a caller states its intent in the filename and nothing else
 * has to know. It matters more than it looks: a real capture here is 20.5 MB of
 * JSON and 0.6 MB gzipped, git stores both at about 0.6 MB, so the compressed
 * form costs nothing in the repository and saves 20 MB in every working tree.
 * The uncompressed form stays the default because a small fixture should be
 * readable and diffable.
 */
function isGzipped(filePath: string): boolean {
	return filePath.endsWith('.gz');
}

/**
 * Write a captured stream to a file a replay can read anywhere.
 *
 * Indented by default, because a fixture is a committed artifact: it is read by
 * humans deciding whether to trust it, and diffed when it is re-captured, and
 * both of those are worthless on one long line. Indentation costs nothing in a
 * `.gz` fixture, since it compresses away.
 */
export function saveStreamFixture<ABI extends Abi>(filePath: string, fixture: StreamFixture<ABI>, indent = 2): void {
	const folder = path.dirname(filePath);
	if (folder && !fs.existsSync(folder)) {
		fs.mkdirSync(folder, {recursive: true});
	}
	const text = serializeStreamFixture(fixture, indent);
	fs.writeFileSync(filePath, isGzipped(filePath) ? zlib.gzipSync(text) : text);
}

/** Read a fixture from a file, gunzipping it when the path says so. Throws, with the path named, if it is not one. */
export function loadStreamFixture<ABI extends Abi>(filePath: string): StreamFixture<ABI> {
	const text = isGzipped(filePath)
		? zlib.gunzipSync(fs.readFileSync(filePath)).toString('utf-8')
		: fs.readFileSync(filePath, 'utf-8');
	try {
		return parseStreamFixture<ABI>(text);
	} catch (err) {
		throw new Error(`${filePath}: ${(err as Error).message}`);
	}
}
