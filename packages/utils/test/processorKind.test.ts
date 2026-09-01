import {describe, expect, it} from 'vitest';
import type {Abi} from '@etherfold/core';
import {
	instantiateProcessor,
	instantiateProcessorWithKind,
	type ProcessorModule,
	type ResolvedProcessor,
} from '../src/processorSetup.js';

// ---------------------------------------------------------------------------------------------------
// THE PROCESSOR KIND COMES FROM THE MODULE
// ---------------------------------------------------------------------------------------------------
// `@etherfold/browser` already takes the kind as a TAG the caller wrote --
// `{kind: 'entities', processor}`, or a bare processor meaning `'js-object'`
// (`ProcessorKind` / `TaggedProcessor` in `packages/browser/src/IndexerState.ts`).
// A host that loads a processor from a MODULE has the same question and must not
// answer it a second way: a `--kind` flag would be a second source of truth for
// one fact, and two answers that can disagree is exactly what the browser's tag
// exists to prevent.
//
// So the module says it, in the same vocabulary, by returning the same
// `{kind, processor}` shape from `createProcessor`. What the tag CARRIES differs
// by necessity and is stated where the type is declared: the browser is handed a
// processor already bound to a store, while a module cannot be -- the store is
// the deployment's choice -- so an `'entities'` module hands over the AUTHORING
// object and the host builds the runtime around it.
//
// Untagged still means `'js-object'`, so every module that ships today keeps
// working with nothing added to it.
// ---------------------------------------------------------------------------------------------------

/**
 * A module as `import()` actually delivers one: UNVALIDATED.
 *
 * Same door the production code goes through, so the guards below are reached
 * the way a foreign module reaches them rather than being typed out of existence.
 */
function asImported<ABI extends Abi, ProcessResultType>(mod: object): ProcessorModule<ABI, ProcessResultType> {
	return mod as ProcessorModule<ABI, ProcessResultType>;
}

const jsObjectProcessor = {getVersionHash: () => 'h', keepState: () => {}} as any;
const entityProcessor = {version: '1.0.0', entities: [{name: 'nft', id: ['id'], fields: {}}]} as any;

describe('instantiateProcessorWithKind', () => {
	it('reads an untagged factory result as the kind that shipped', () => {
		const resolved = instantiateProcessorWithKind(asImported({createProcessor: () => jsObjectProcessor}), {
			processorPath: './processor.js',
		});
		expect(resolved.kind).toBe('js-object');
		expect(resolved.processor).toBe(jsObjectProcessor);
	});

	it('reads a bare processor OBJECT (not a factory) as js-object too', () => {
		const resolved = instantiateProcessorWithKind(asImported({createProcessor: jsObjectProcessor}), {
			processorPath: './processor.js',
		});
		expect(resolved.kind).toBe('js-object');
		expect(resolved.processor).toBe(jsObjectProcessor);
	});

	it('reads the tag a module wrote, and hands back what the tag carries', () => {
		const resolved = instantiateProcessorWithKind(
			asImported({createProcessor: () => ({kind: 'entities', processor: entityProcessor})}),
			{processorPath: './processor.js'},
		);
		expect(resolved.kind).toBe('entities');
		expect(resolved.processor).toBe(entityProcessor);
	});

	it('accepts a tagged js-object module, so a module may be explicit about the default', () => {
		const resolved = instantiateProcessorWithKind(
			asImported({createProcessor: () => ({kind: 'js-object', processor: jsObjectProcessor})}),
			{processorPath: './processor.js'},
		);
		expect(resolved.kind).toBe('js-object');
		expect(resolved.processor).toBe(jsObjectProcessor);
	});

	it('passes the factory argument through exactly as instantiateProcessor does', () => {
		const seen: unknown[] = [];
		instantiateProcessorWithKind(
			asImported({
				createProcessor: (config?: unknown) => {
					seen.push(config);
					return jsObjectProcessor;
				},
			}),
			{processorPath: './processor.js', processorConfig: {folder: 'here'}},
		);
		expect(seen).toEqual([{folder: 'here'}]);
	});

	it('refuses a kind that is not one of the two, naming both', () => {
		expect(() =>
			instantiateProcessorWithKind(
				asImported({createProcessor: () => ({kind: 'sqlite', processor: entityProcessor})}),
				{processorPath: './processor.js'},
			),
		).toThrow(/"sqlite".*'js-object'.*'entities'/s);
	});

	it('refuses a tag that carries no processor', () => {
		expect(() =>
			instantiateProcessorWithKind(asImported({createProcessor: () => ({kind: 'entities'})}), {
				processorPath: './processor.js',
			}),
		).toThrow(/no "processor"/);
	});

	it('keeps the module-shape refusals it shares with instantiateProcessor', () => {
		expect(() => instantiateProcessorWithKind(asImported({}), {processorPath: './processor.js'})).toThrow(
			/processor field could not be found/,
		);
		expect(() =>
			instantiateProcessorWithKind(asImported({createProcessor: () => undefined}), {processorPath: './processor.js'}),
		).toThrow(/Processor could not be created/);
	});

	it('narrows on the tag, so the entity arm is typed by the caller that owns the runtime', () => {
		type MyEntityProcessor = {version: string; entities: unknown[]};
		const resolved: ResolvedProcessor<Abi, unknown, MyEntityProcessor> = instantiateProcessorWithKind<
			Abi,
			unknown,
			MyEntityProcessor
		>(asImported({createProcessor: () => ({kind: 'entities', processor: entityProcessor})}), {
			processorPath: './processor.js',
		});
		if (resolved.kind !== 'entities') throw new Error('expected the entity arm');
		// a compile-time assertion as much as a runtime one: the entity arm carries
		// the caller's type, so no cast is needed at the wiring site
		expect(resolved.processor.version).toBe('1.0.0');
	});
});

describe('instantiateProcessor — the js-object door', () => {
	it('still returns the EventProcessor an untagged module produces', () => {
		const processor = instantiateProcessor(asImported({createProcessor: () => jsObjectProcessor}), {
			processorPath: './processor.js',
		});
		expect(processor).toBe(jsObjectProcessor);
	});

	it('unwraps a tagged js-object module', () => {
		const processor = instantiateProcessor(
			asImported({createProcessor: () => ({kind: 'js-object', processor: jsObjectProcessor})}),
			{processorPath: './processor.js'},
		);
		expect(processor).toBe(jsObjectProcessor);
	});

	it('refuses an entity module rather than handing back an object that is not an EventProcessor', () => {
		expect(() =>
			instantiateProcessor(asImported({createProcessor: () => ({kind: 'entities', processor: entityProcessor})}), {
				processorPath: './processor.js',
			}),
		).toThrow(/'entities'/);
	});
});
