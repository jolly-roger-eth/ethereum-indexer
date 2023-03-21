import {createProcessor, contractsData as _contractsData} from 'event-processor-nfts';
import {readable} from 'svelte/store';

export const initialFactory = createProcessor;

export const contractsData = _contractsData;

let _setFactory: any;
export const processorFactory = readable<typeof createProcessor>(createProcessor, (set) => {
	_setFactory = set;
});

export function _asNewModule(set: any) {
	_setFactory = set;
}

if (import.meta.hot) {
	import.meta.hot.accept((newModule) => {
		newModule?._asNewModule(_setFactory);
		if (_setFactory) {
			_setFactory(newModule?.initialFactory);
		}
	});
}
