import {describe, expect, it} from 'vitest';
import type {Abi} from '@etherfold/core';
import {instantiateProcessor, type ProcessorModule} from '../src/processorSetup.js';

// ---------------------------------------------------------------------------------------------------
// A MODULE HANDS OVER THE PROCESSOR, AND THAT IS THE WHOLE CONTRACT
// ---------------------------------------------------------------------------------------------------
// It used to hand over a `{kind, processor}` TAG saying which of two authoring
// paths it carried, with an untagged module meaning `'js-object'` (ADR-0039).
// There is one authoring path now (ADR-0037), so the tag discriminates nothing
// and `createProcessor` returns the AUTHORING object itself: declarations plus
// handlers, naming no backend, because WHERE the state lives is the deployment's
// choice and the host builds the runtime around what comes back.
//
// A module that still returns the tag is REFUSED rather than unwrapped, and that
// refusal is what this file mostly exists for: unwrapping it would keep a second
// module shape alive forever, and NOT refusing it would let a wrapper reach a
// store that asks it for `entities` and gets `undefined` three frames later.
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

const entityProcessor = {version: '1.0.0', entities: [{name: 'nft', id: ['id'], fields: {}}]} as any;

describe('instantiateProcessor', () => {
	it('hands back what the factory made', () => {
		const processor = instantiateProcessor(asImported({createProcessor: () => entityProcessor}), {
			processorPath: './processor.js',
		});
		expect(processor).toBe(entityProcessor);
	});

	it('takes a bare processor OBJECT (not a factory) too', () => {
		const processor = instantiateProcessor(asImported({createProcessor: entityProcessor}), {
			processorPath: './processor.js',
		});
		expect(processor).toBe(entityProcessor);
	});

	it('passes the factory argument through', () => {
		const seen: unknown[] = [];
		instantiateProcessor(
			asImported({
				createProcessor: (config?: unknown) => {
					seen.push(config);
					return entityProcessor;
				},
			}),
			{processorPath: './processor.js', processorConfig: {folder: 'here'}},
		);
		expect(seen).toEqual([{folder: 'here'}]);
	});

	it('refuses the retired KIND TAG rather than unwrapping it, naming the ADR', () => {
		expect(() =>
			instantiateProcessor(asImported({createProcessor: () => ({kind: 'entities', processor: entityProcessor})}), {
				processorPath: './processor.js',
			}),
		).toThrow(/"entities".*ADR-0037.*createProcessor/s);
	});

	it('refuses the other tag the same way, without arguing about which kind it named', () => {
		expect(() =>
			instantiateProcessor(asImported({createProcessor: () => ({kind: 'js-object', processor: entityProcessor})}), {
				processorPath: './processor.js',
			}),
		).toThrow(/ADR-0037/);
	});

	it('keeps the module-shape refusals', () => {
		expect(() => instantiateProcessor(asImported({}), {processorPath: './processor.js'})).toThrow(
			/processor field could not be found/,
		);
		expect(() =>
			instantiateProcessor(asImported({createProcessor: () => undefined}), {processorPath: './processor.js'}),
		).toThrow(/Processor could not be created/);
	});

	it('is typed by the CALLER, so the host that owns the runtime needs no cast', () => {
		type MyEntityProcessor = {version: string; entities: unknown[]};
		const resolved = instantiateProcessor<Abi, unknown, MyEntityProcessor>(
			asImported({createProcessor: () => entityProcessor}),
			{processorPath: './processor.js'},
		);
		// a compile-time assertion as much as a runtime one
		expect(resolved.version).toBe('1.0.0');
	});
});
