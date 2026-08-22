import {Patch, applyPatches} from './immer.js';
import {JSObject} from './types.js';

export type HistoryJSObject = {
	reversals: {[blockHash: string]: Patch[][]};
	blockHashes: {[blockNumber: number]: string};
};

export class History {
	protected blockNumber: number | undefined;
	protected blockHash: string | undefined;
	protected finality: number | undefined;
	constructor(protected historyJSON: HistoryJSObject) {}

	setFinality(finality: number) {
		this.finality = finality;
	}

	setBlock(blockNumber: number, blockHash: string) {
		if (!this.finality) {
			throw new Error(`finality not set`);
		}
		this.blockNumber = blockNumber;
		this.blockHash = blockHash;
		for (const key of Object.keys(this.historyJSON.blockHashes)) {
			if (blockNumber - parseInt(key) > this.finality) {
				const blockHash = this.historyJSON.blockHashes[parseInt(key)];
				delete this.historyJSON.reversals[blockHash];
				delete this.historyJSON.blockHashes[parseInt(key)];
			}
		}
		this.historyJSON.blockHashes[blockNumber] = blockHash;
	}

	reverseBlock<T extends JSObject>(blockNumber: number, blockHash: string, json: T): T {
		if (!this.blockHash) {
			throw new Error(`no blockhash set`);
		}

		const patches = this.historyJSON.reversals[blockHash];
		for (let i = patches.length - 1; i >= 0; i--) {
			json = applyPatches(json, patches[i]);
		}

		delete this.historyJSON.reversals[blockHash];
		delete this.historyJSON.blockHashes[blockNumber];
		return json;
	}

	setReversal(patches: Patch[]) {
		if (!this.blockHash) {
			throw new Error(`no blockhash set`);
		}
		this.historyJSON.reversals[this.blockHash] = this.historyJSON.reversals[this.blockHash] || [];
		this.historyJSON.reversals[this.blockHash].push(patches);
	}
}
