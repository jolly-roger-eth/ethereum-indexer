import {Abi, IndexingSource, LastSync, LogEvent} from 'ethereum-indexer';
import {get, set, del} from 'idb-keyval';

type StreamData<ABI extends Abi> = {
	lastSync: LastSync<ABI>;
	eventStream: LogEvent<ABI, undefined>[];
};

export function keepStreamOnIndexedDB<ABI extends Abi>(name: string) {
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
			await del(storageID, undefined);
		},
	};
}
