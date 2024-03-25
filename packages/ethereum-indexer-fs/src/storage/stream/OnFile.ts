import {Abi, IndexingSource, LastSync, LogEvent} from 'ethereum-indexer';
import { storage } from '../../utils/fs';

type StreamData<ABI extends Abi> = {
	lastSync: LastSync<ABI>;
	eventStream: LogEvent<ABI, undefined>[];
};

export function keepStreamOnFile<ABI extends Abi>(folder: string, name: string) {
	const {get,set,del} = storage(folder);
	return {
		fetchFrom: async (source: IndexingSource<ABI>, fromBlock: number) => {
			const storageID = `stream_${name}_${source.chainId}`;

			const existingStream = await get<StreamData<ABI>>(storageID);
			return existingStream
				? {
						eventStream: existingStream.eventStream.filter((v: any) => v.blockNumber >= fromBlock),
						lastSync: existingStream.lastSync,
				  }
				: undefined;
		},
		saveNewEvents: async (source: IndexingSource<ABI>, stream: StreamData<ABI>) => {
			const storageID = `stream_${name}_${source.chainId}`;

			const existingStream = await get<StreamData<ABI>>(storageID);

			if (existingStream && existingStream.eventStream.length > 0) {
				if (stream.eventStream.length > 0) {
					const eventStreamToSave = existingStream.eventStream.concat(stream.eventStream);
					await set(storageID, {lastSync: stream.lastSync, eventStream: eventStreamToSave});
				} else {
					await set(storageID, {lastSync: stream.lastSync, eventStream: existingStream.eventStream});
				}
			} else {
				await set(storageID, stream);
			}
		},
		async clear(source: IndexingSource<ABI>) {
			const storageID = `stream_${name}_${source.chainId}`;
			await del(storageID);
		},
	};
}
