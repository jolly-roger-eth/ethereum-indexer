import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

// ---------------------------------------------------------------------------------------------------
// THERE IS ONE SERVER-SIDE FOLDING ENGINE, AND IT IS NOT `EthereumIndexer`
// ---------------------------------------------------------------------------------------------------
// `work/specs/ready/one-command-runs-the-whole-pipeline.md` builds `run` and
// `index` on the same `StreamBuilder` and asserts they produce identical state
// from the same input. That assertion is worth making only if the transport is
// the only difference between them: if this command folded through
// `EthereumIndexer` instead, the equivalence would be between two
// IMPLEMENTATIONS that happen to agree today, and every later divergence would
// surface as a mysteriously failing equivalence test rather than as a bug in one
// place.
//
// So it is asserted rather than claimed, by reading this package's own sources.
// A grep is crude and it is the right shape here: what must not exist is a
// construction, and the file that would introduce one is the file this reads.
// That engine stays the browser's.
//
// IT HAS TWO NAMES DURING THE RENAME, AND THE GUARD MATCHES BOTH. The class is
// `IndexerGeneration` now -- one stream, one processor, one state IS a
// GENERATION -- and `EthereumIndexer` remains as an alias to it until the
// contract batch (`the-old-indexer-shape-is-deleted`) removes it. A guard left
// on the old spelling alone would stay GREEN and stop enforcing anything the
// moment a file used the new one, which is worse than no guard. Deliberately NOT
// extended to `Indexer`, the generation CONTAINER: whether a CLI holds
// generations is `the-server-and-cli-hold-generations-too`'s question, and a
// grep here must not pre-answer it.
// ---------------------------------------------------------------------------------------------------

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

function sources(): {file: string; text: string}[] {
	return fs
		.readdirSync(src)
		.filter((name) => name.endsWith('.ts'))
		.map((file) => ({file, text: fs.readFileSync(path.join(src, file), 'utf-8')}));
}

describe("the CLI's indexing path", () => {
	it('constructs no IndexerGeneration, under either of its names', () => {
		const offenders = sources().filter(({text}) =>
			/new\s+(EthereumIndexer|IndexerGeneration)\b|\b(EthereumIndexer|IndexerGeneration)\s*[<(]/.test(text),
		);
		expect(offenders.map(({file}) => file)).toEqual([]);
	});

	it('imports it under neither name either, so nothing can quietly start using one', () => {
		const offenders = sources().filter(({text}) =>
			// the words appear in prose here (this package explains why it does NOT use
			// that class), so the check is on an IMPORT of the identifier
			/import\s*\{[^}]*\b(EthereumIndexer|IndexerGeneration)\b[^}]*\}/.test(text),
		);
		expect(offenders.map(({file}) => file)).toEqual([]);
	});

	it('assembles the two ADR-0003 halves instead', () => {
		const index = fs.readFileSync(path.join(src, 'index.ts'), 'utf-8');
		expect(index).toMatch(/new StreamBuilder/);
		expect(index).toMatch(/createDirectIngestion/);
		// the LogFetcher is built by the fetcher host, which also owns the cycle
		// classification and the backoff this command's one-shot rides on
		expect(index).toMatch(/createFetcherHost/);
		expect(index).toMatch(/runFetcherLoop/);
	});
});
