import {Abi, LastSync, ProcessorContext, simple_hash} from 'ethereum-indexer';
import {filterOutFieldsFromObject} from './javascript';

export function formatLastSync<ABI extends Abi>(lastSync: LastSync<ABI>): any {
	return filterOutFieldsFromObject(lastSync, ['_rev', '_id', 'batch']);
}


export function contextFilenames(context: ProcessorContext<Abi, any>) {
	const configHash = 'config' in context && context.config ? simple_hash(context.config) : undefined;
	const sourceHash = simple_hash(context.source);
	const networkString = `${context.source.chainId }${(context.source.chainId == '1337' || context.source.chainId == '31337') && context.source.genesisHash ? `-${context.source.genesisHash}`: ''}`
	const prefix = `${networkString}-${sourceHash}${configHash ? `-${configHash}`: ``}${context.version ? `-${context.version}`: ``}`;
	const stateFile = `${prefix}-state.json`;
	const lastSyncFile = `${prefix}-lastSync.json`;
	return {stateFile,lastSyncFile}
}