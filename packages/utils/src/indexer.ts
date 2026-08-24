/**
 * The half of this package a BROWSER can import, and the reason it has a
 * subpath of its own (`@etherfold/utils/indexer`).
 *
 * The barrel (`@etherfold/utils`) also re-exports `contracts.ts` and
 * `processorSetup.ts`, which read the filesystem and `createRequire` a processor
 * module: `node:fs`, `node:path`, `node:module`. Those are the CLI's and the
 * server's business, and they are top-level imports, so a bundler asked to build
 * anything that touches the barrel fails to resolve them before tree-shaking
 * ever gets a chance. `@etherfold/browser` needs exactly `contextFilenames`
 * from here -- the naming scheme a published snapshot is fetched under, which
 * the CLI and a browser client MUST agree on, which is why it is shared code and
 * not copied.
 *
 * So: nothing in this module may import a runtime built-in. Whatever does
 * belongs in `contracts.ts` or `processorSetup.ts`, behind the barrel.
 */
import {Abi, LastSync, ProcessorContext, simple_hash} from '@etherfold/core';
import {filterOutFieldsFromObject} from './javascript.js';

export function formatLastSync<ABI extends Abi>(lastSync: LastSync<ABI>): any {
	return filterOutFieldsFromObject(lastSync, ['_rev', '_id', 'batch']);
}

export function contextFilenames(context: ProcessorContext<Abi, any>) {
	const configHash = 'config' in context && context.config ? simple_hash(context.config) : undefined;
	const sourceHash = simple_hash(context.source);
	const networkString = `${context.source.chainId}${(context.source.chainId == '1337' || context.source.chainId == '31337') && context.source.genesisHash ? `-${context.source.genesisHash}` : ''}`;
	const prefix = `${networkString}-${sourceHash}${configHash ? `-${configHash}` : ``}${context.version ? `-${context.version}` : ``}`;
	const stateFile = `${prefix}-state.json`;
	const lastSyncFile = `${prefix}-lastSync.json`;
	return {stateFile, lastSyncFile};
}
