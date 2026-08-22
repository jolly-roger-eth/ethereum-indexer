import {isBigIntLiteral} from '@etherfold/core';

/** The guard lives in the core, because six copies of it all had the same bug. */
export function bnReviver(k: string, v: any): any {
	return isBigIntLiteral(v) ? BigInt(v.slice(0, -1)) : v;
}
export function bnReplacer(k: string, v: any): any {
	if (typeof v === 'bigint') {
		return v.toString() + 'n';
	}
	return v;
}
