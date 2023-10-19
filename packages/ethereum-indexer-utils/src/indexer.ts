import {Abi, LastSync} from 'ethereum-indexer';
import {filterOutFieldsFromObject} from './javascript';

export function formatLastSync<ABI extends Abi>(lastSync: LastSync<ABI>): any {
	return filterOutFieldsFromObject(lastSync, ['_rev', '_id', 'batch']);
}
