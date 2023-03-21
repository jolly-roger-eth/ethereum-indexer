import {Abi, LogEvent} from 'ethereum-indexer';

export function computeArchiveID(id: string, endBlock: number): string {
	return `archive_${endBlock}_${id}`;
}

export function computeEventID<ABI extends Abi>(event: LogEvent<ABI>): string {
	return `${event.transactionHash}_${event.logIndex}`;
}

export function bnReplacer(v: any): any {
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

export function bnReviver(v: any): any {
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
