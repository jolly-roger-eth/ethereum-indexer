import type {Abi, AllContractData, ContractData, EventProcessor, IndexingSource} from '@etherfold/core';
import {createRequire} from 'node:module';
import path from 'node:path';
import {logs} from 'named-logs';

const logger = logs('@etherfold/utils:processorSetup');

// Minimal EIP-1193 provider surface this module needs (just `eth_chainId`). Kept structural so both
// the CLI's `JSONRPCHTTPProvider` and the server's provider satisfy it, and so tests can inject a
// fake without depending on `eip-1193`.
export type ChainIdProvider = {
	request(args: {method: 'eth_chainId'}): Promise<unknown>;
};

// A processor module is whatever `import()`-ing the processor path yields. It may export a
// `createProcessor` factory (function or already-built processor) plus contract data via
// `contractsDataPerChain` (indexed by decimal chainId) and/or `contractsData`.
export type ProcessorModule<ABI extends Abi, ProcessResultType> = {
	createProcessor?: ((config?: any) => EventProcessor<ABI, ProcessResultType>) | EventProcessor<ABI, ProcessResultType>;
	contractsDataPerChain?: {[chainId: string]: AllContractData<ABI> | ContractData<ABI>[]};
	contractsData?: AllContractData<ABI> | ContractData<ABI>[];
	[key: string]: any;
};

// ---------------------------------------------------------------------------------------------------
// loadProcessorModule
// ---------------------------------------------------------------------------------------------------

export type LoadProcessorModuleOptions = {
	// Importer used to load the module. Defaults to the dynamic `import()`. Injectable for tests.
	importModule?: (specifier: string) => Promise<any>;
	// Module resolver used for the fallback (mirrors `createRequire(cwd/node_modules).resolve`).
	// Defaults to the real `createRequire` resolver. Injectable for tests.
	requireResolve?: (specifier: string) => string;
	// Working directory used to resolve relative paths. Defaults to `process.cwd()`.
	cwd?: string;
};

// Import the processor module by path. Behaviour (superset of the previous CLI/server copies):
//  - absolute path: imported directly.
//  - relative path: joined against `cwd` and imported; if that import fails, fall back to resolving
//    the specifier through `createRequire(cwd/node_modules).resolve(...)` (this is the server's
//    fallback, kept as the shared superset so a bare package specifier still resolves).
export async function loadProcessorModule<ABI extends Abi, ProcessResultType>(
	processorPath: string,
	options?: LoadProcessorModuleOptions,
): Promise<ProcessorModule<ABI, ProcessResultType>> {
	const cwd = options?.cwd ?? process.cwd();
	const importModule = options?.importModule ?? ((specifier: string) => import(specifier));
	const requireResolve =
		options?.requireResolve ?? ((specifier: string) => createRequire(`${cwd}/node_modules/`).resolve(specifier));

	if (path.isAbsolute(processorPath)) {
		return await importModule(processorPath);
	}

	try {
		return await importModule(path.join(cwd, processorPath));
	} catch (err) {
		// Fallback: resolve the specifier as a package/module name relative to cwd's node_modules.
		return await importModule(requireResolve(processorPath));
	}
}

// ---------------------------------------------------------------------------------------------------
// instantiateProcessor
// ---------------------------------------------------------------------------------------------------

export type InstantiateProcessorOptions = {
	// Path of the module, used only for error messages.
	processorPath: string;
	// Argument passed to the `createProcessor` factory. The CLI passes nothing; the server passes its
	// `folder`. Making this an explicit parameter keeps the caller difference intentional rather than
	// accidental (see MEDIUM-3 in the findings). When omitted the factory is called with no args.
	processorConfig?: any;
};

/**
 * WHICH of the two authoring paths a processor module carries.
 *
 * The SAME vocabulary `@etherfold/browser` uses (`ProcessorKind` there,
 * `CONTEXT.md`'s "processor kind" here), and deliberately not a second one: a
 * deployment says which path it is running exactly once, and the two runtimes
 * must call it by the same name or the glossary forks.
 *
 * It is declared here rather than imported from `@etherfold/browser` because
 * this package must not depend on a browser runtime to type a module's export --
 * the same reason `@etherfold/browser` types its own entity arm structurally.
 */
export type ProcessorKind = 'js-object' | 'entities';

/**
 * A processor plus the KIND its MODULE says it is.
 *
 * The counterpart of `TaggedProcessor` in `@etherfold/browser`, and the
 * difference between the two is not an accident to be tidied away:
 *
 * - the BROWSER is handed a processor that is already an `EventProcessor` --
 *   the application built the store first, so `{kind: 'entities', processor}`
 *   carries the runtime;
 * - a MODULE cannot do that, because WHERE the state lives is the deployment's
 *   choice and a module that picked one would have made it for every host that
 *   loads it. So the `'entities'` arm carries the AUTHORING object (declarations
 *   plus handlers) and the host builds the runtime around it.
 *
 * The `'entities'` arm is typed by the CALLER, through `EntityProcessorType`, so
 * a host that owns an entity runtime gets its own type at the wiring site while
 * this package keeps naming none of them. It defaults to `unknown`, which is the
 * honest type for a caller that has not said.
 */
export type ResolvedProcessor<ABI extends Abi, ProcessResultType, EntityProcessorType = unknown> =
	| {readonly kind: 'js-object'; readonly processor: EventProcessor<ABI, ProcessResultType>}
	| {readonly kind: 'entities'; readonly processor: EntityProcessorType};

// Call the module's `createProcessor` (or use it as-is when it is already an object) and hand back
// whatever it produced, unread. Shared by both doors below so the module-shape refusals -- and the
// exact no-arg call the CLI has always made -- exist once.
function createFromModule<ABI extends Abi, ProcessResultType>(
	processorModule: ProcessorModule<ABI, ProcessResultType>,
	options: InstantiateProcessorOptions,
): unknown {
	const processorFactory = processorModule.createProcessor;

	if (!processorFactory) {
		throw new Error(
			`processor field could not be found: check module at ${options.processorPath} if it exports a "processor" field`,
		);
	}

	if (typeof processorFactory !== 'function') {
		return processorFactory;
	}

	// Pass processorConfig only when provided so the no-arg CLI call stays byte-identical.
	const created =
		'processorConfig' in options
			? (processorFactory as (config?: any) => unknown)(options.processorConfig)
			: (processorFactory as () => unknown)();

	if (!created) {
		throw new Error(
			`Processor could not be created, check the function exported as "processor" in module ${options.processorPath}`,
		);
	}

	return created;
}

/**
 * Read the KIND tag a module wrote, or supply the one an untagged module means.
 *
 * `'kind' in value` reads the DISCRIMINANT -- the one property the author put
 * there to be read -- exactly as `@etherfold/browser` does it. Nothing here asks
 * whether `createInitialState` or `entities` is present: both kinds are
 * `EventProcessor`-shaped objects to a sniffer, so a guess is one a wrapper or a
 * proxy can make wrong in silence, and the wrong branch does not fail, it
 * indexes into the wrong place.
 *
 * An UNTAGGED module means `'js-object'`, which is the form every module that
 * ships today has, so none of them changes to keep running.
 */
export function instantiateProcessorWithKind<ABI extends Abi, ProcessResultType, EntityProcessorType = unknown>(
	processorModule: ProcessorModule<ABI, ProcessResultType>,
	options: InstantiateProcessorOptions,
): ResolvedProcessor<ABI, ProcessResultType, EntityProcessorType> {
	const created = createFromModule<ABI, ProcessResultType>(processorModule, options);

	if (typeof created !== 'object' || created === null || !('kind' in created)) {
		return {kind: 'js-object', processor: created as EventProcessor<ABI, ProcessResultType>};
	}

	const {kind, processor} = created as {kind: unknown; processor?: unknown};
	if (kind !== 'js-object' && kind !== 'entities') {
		throw new Error(
			`the processor module at ${options.processorPath} declares kind ${JSON.stringify(kind)}, which is not a ` +
				`processor kind. It is 'js-object' (the state is a free-form object, persisted whole by a keepState ` +
				`keeper) or 'entities' (the state is rows in a StateStore, which also holds the sync cursor) -- the same ` +
				`two kinds @etherfold/browser takes.`,
		);
	}
	if (!processor) {
		throw new Error(
			`the processor module at ${options.processorPath} declares {kind: '${kind}'} but carries no "processor": a ` +
				`tagged module returns {kind, processor}.`,
		);
	}

	return kind === 'entities'
		? {kind, processor: processor as EntityProcessorType}
		: {kind, processor: processor as EventProcessor<ABI, ProcessResultType>};
}

// Resolve the `createProcessor` factory from the module and instantiate the processor.
//  - if `createProcessor` is a function, call it (with `processorConfig` if provided, else no args).
//  - if `createProcessor` is already a processor object, use it as-is.
// Throws when no factory is found, or when the factory produced nothing.
//
// This is the `'js-object'` door: it hands back the `EventProcessor` the core drives, so a module
// tagged `'entities'` is REFUSED here rather than returned as something that only looks like one.
// A caller that can build a store (the CLI's `--store sqlite` arm) calls `instantiateProcessorWithKind`
// instead and gets the tag.
export function instantiateProcessor<ABI extends Abi, ProcessResultType>(
	processorModule: ProcessorModule<ABI, ProcessResultType>,
	options: InstantiateProcessorOptions,
): EventProcessor<ABI, ProcessResultType> {
	const resolved = instantiateProcessorWithKind<ABI, ProcessResultType>(processorModule, options);
	if (resolved.kind === 'entities') {
		throw new Error(
			`the processor module at ${options.processorPath} declares kind 'entities', and this caller can only drive a ` +
				`'js-object' processor. An entity processor's state -- and its sync cursor -- live in a StateStore, which ` +
				`only a deployment can choose.`,
		);
	}
	return resolved.processor;
}

// ---------------------------------------------------------------------------------------------------
// resolveSource
// ---------------------------------------------------------------------------------------------------

// Resolve the indexing source (chainId + contracts) from a processor module, fetching `eth_chainId`
// only when `contractsDataPerChain` is present (preserving the original CLI/server behaviour where
// `contractsData`-only modules never triggered a chainId fetch).
//
// Resolution order:
//  1. if `contractsDataPerChain` exists, fetch chainId and try `contractsDataPerChain[chainId]`.
//  2. fall back to `contractsData`.
// Throws "no chainId found" when no chainId was determined, and "no contracts data found" when no
// contracts could be resolved.
export async function resolveSource<ABI extends Abi, ProcessResultType>(
	processorModule: ProcessorModule<ABI, ProcessResultType>,
	provider: ChainIdProvider,
): Promise<IndexingSource<ABI>> {
	let contractsData: AllContractData<ABI> | ContractData<ABI>[] | undefined;
	let chainIDAsDecimal: string | undefined;

	if (processorModule.contractsDataPerChain) {
		let chainIDAsHex: `0x${string}`;
		try {
			chainIDAsHex = (await provider.request({method: 'eth_chainId'})) as `0x${string}`;
		} catch (err) {
			// Use console.error (not the named-logs logger) so the diagnostic always reaches stderr. This
			// matches BOTH original callers exactly: the CLI does not wire `named-logs-console`, so a
			// `logger.error` here would be a silent no-op and lose the message.
			console.error(`could not fetch chainID`);
			throw err;
		}
		chainIDAsDecimal = '' + parseInt(chainIDAsHex.slice(2), 16);
		logger.info(processorModule.contractsDataPerChain);
		logger.info({chainIDAsHex, chainIDAsDecimal});
		contractsData = processorModule.contractsDataPerChain[chainIDAsDecimal];
	}
	if (!contractsData) {
		contractsData = processorModule.contractsData;
	}

	if (processorModule.contractsDataPerChain && !contractsData) {
		// console.error (not the named-logs logger) to match both original callers' stderr output.
		console.error(`field "contractsDataPerChain" found but no contracts data found for chainID: ${chainIDAsDecimal}`);
	}

	if (!chainIDAsDecimal) {
		throw new Error(`no chainId found`);
	}

	if (!contractsData) {
		throw new Error(`no contracts data found`);
	}

	return {
		chainId: chainIDAsDecimal,
		contracts: contractsData,
	};
}

// ---------------------------------------------------------------------------------------------------
// resolveProcessorAndSource — orchestration
// ---------------------------------------------------------------------------------------------------

export type ResolveProcessorAndSourceOptions<ABI extends Abi> = {
	// Path to the processor module (absolute or relative to `cwd`).
	processorPath: string;
	// Provider used to fetch `eth_chainId` when resolving the source from the module.
	provider: ChainIdProvider;
	// When provided, used as-is and no source is resolved from the module (the deployments path).
	source?: IndexingSource<ABI>;
	// Argument passed to the processor factory (see `instantiateProcessor`). Omit for the no-arg call.
	processorConfig?: any;
	// Module import collaborators (see `loadProcessorModule`). Injectable for tests.
	importModule?: (specifier: string) => Promise<any>;
	requireResolve?: (specifier: string) => string;
	cwd?: string;
};

export type ResolveProcessorAndSourceResult<ABI extends Abi, ProcessResultType> = {
	processor: EventProcessor<ABI, ProcessResultType>;
	processorModule: ProcessorModule<ABI, ProcessResultType>;
	source: IndexingSource<ABI>;
};

// Shared replacement for the near-identical processor/source setup previously copy-pasted in the CLI
// `init()` and the server `setupIndexing()`. Loads the module, instantiates the processor (with the
// explicit factory arg), and resolves the source (or uses the provided one). Returns the trio the
// callers need; each caller keeps owning provider construction, keepState wiring, caching and the
// `EthereumIndexer` instantiation.
export async function resolveProcessorAndSource<ABI extends Abi, ProcessResultType>(
	options: ResolveProcessorAndSourceOptions<ABI>,
): Promise<ResolveProcessorAndSourceResult<ABI, ProcessResultType>> {
	const processorModule = await loadProcessorModule<ABI, ProcessResultType>(options.processorPath, {
		importModule: options.importModule,
		requireResolve: options.requireResolve,
		cwd: options.cwd,
	});

	const processor = instantiateProcessor<ABI, ProcessResultType>(
		processorModule,
		'processorConfig' in options
			? {processorPath: options.processorPath, processorConfig: options.processorConfig}
			: {processorPath: options.processorPath},
	);

	let source = options.source;
	if (!source) {
		source = await resolveSource<ABI, ProcessResultType>(processorModule, options.provider);
	}

	if (!source || !source.contracts) {
		throw new Error(
			`contracts data not found in the processor module, it needs to be provided either as exported field named "contractsData" or as field "contractsDataPerChain" indexed by chainID`,
		);
	}

	return {processor, processorModule, source};
}
