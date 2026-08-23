/**
 * Load a captured stream in the browser, gzipped or not.
 *
 * The committed fixture is `.gz` because it is 20.5 MB of JSON and 0.6 MB
 * compressed. The harness's static server serves it as a plain file and does NOT
 * set `Content-Encoding: gzip`, which is the honest thing for it to do (the file
 * IS the artifact, and pretending otherwise would make it undownloadable), so
 * the decompression happens here, in the one place that knows.
 *
 * `DecompressionStream('gzip')` is native in all three engines this spike
 * measures (Chromium 80+, Firefox 113+, Safari 16.4+), so this costs no bundle
 * weight and no dependency.
 */
import {parseStreamFixture, type StreamFixture} from '../../../../../packages/core/dist/stream/fixture.js';
import type {Abi} from '../../../../../packages/core/dist/index.js';

export async function fetchStreamFixture<ABI extends Abi>(url: string): Promise<StreamFixture<ABI>> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`${url}: ${response.status} ${response.statusText}`);
	}
	if (!url.endsWith('.gz')) {
		return parseStreamFixture<ABI>(await response.text());
	}
	const stream = (response.body as ReadableStream<Uint8Array>).pipeThrough(new DecompressionStream('gzip'));
	return parseStreamFixture<ABI>(await new Response(stream).text());
}
