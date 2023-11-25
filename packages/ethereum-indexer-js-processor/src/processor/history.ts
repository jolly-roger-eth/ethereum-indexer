import {Patch, applyPatches} from './immer';
import {JSObject} from './types';

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
		for (let i = patches.length - 1; i <= 0; i--) {
			json = applyPatches(json, patches[i]);
		}

		delete this.historyJSON.reversals[blockHash];
		delete this.historyJSON.blockHashes[blockNumber];
		return json;
	}

	setReversal(patches: Patch[]) {
		if (patches === undefined || patches === null) {
			throw new Error(`no patches provided`)
		}
		if (!this.blockHash) {
			throw new Error(`no blockhash set`);
		}
		this.historyJSON.reversals[this.blockHash] = this.historyJSON.reversals[this.blockHash] || [];
		this.historyJSON.reversals[this.blockHash].push(patches);
	}
}

// TODO have a base utils lib
function bnReplacer(v: any): any {
	if (typeof v === 'bigint') {
		return v.toString() + 'n';
	} else {
		if (typeof v === 'object') {
			if (Array.isArray(v)) {
				return v.map((v) => bnReplacer(v));
			} else {
				const keys = Object.keys(v);
				const n = {};
				for (const key of keys) {
					(n as any)[key] = bnReplacer(v[key]);
				}
				return n;
			}
		} else {
			return v;
		}
	}
}

function bnReviver(v: any): any {
	if (
		typeof v === 'string' &&
		(v.startsWith('-') ? !isNaN(parseInt(v.charAt(1))) : !isNaN(parseInt(v.charAt(0)))) &&
		v.charAt(v.length - 1) === 'n'
	) {
		return BigInt(v.slice(0, -1));
	} else {
		if (typeof v === 'object') {
			if (Array.isArray(v)) {
				return v.map((v) => bnReviver(v));
			} else {
				const keys = Object.keys(v);
				const n = {};
				for (const key of keys) {
					(n as any)[key] = bnReviver(v[key]);
				}
				return n;
			}
		} else {
			return v;
		}
	}
}
