import {JSObject, JSType} from './types';

type ReversalAction =
	| {
			readonly __action__: 'ValueSet';
			value: JSType | undefined | null;
	  }
	| {
			readonly __action__: 'ArraySet';
			actions: (
				| {index: number; value: JSType}
				| {index?: number; values: JSType[]}
				| {index: number; deleteCount: number}
			)[];
	  };

type Reversal = {[property: string]: Reversal | ReversalAction};

export type HistoryJSObject = {
	reversals: {[blockHash: string]: Reversal};
	blockHashes: {[blockNumber: number]: string};
};

function getReversal(
	previousReversal: Reversal,
	fieldPath: string[],
	index?: number
): {actionField: string; parent: Reversal} | {reversal: Reversal} | undefined {
	index = index || 0;
	if (index >= fieldPath.length) {
		return {reversal: previousReversal};
	}
	const property = fieldPath[index];
	const reversal = previousReversal[property];
	if (!reversal) {
		return undefined;
	} else if (reversal.__action__) {
		return {actionField: property, parent: previousReversal};
	} else {
		// we stop right there
		return getReversal(reversal as Reversal, fieldPath, index + 1);
	}
}

function applyAction(json: JSObject | JSType[], action: ReversalAction, property: string) {
	if (action.__action__ === 'ValueSet') {
		if (action.value === undefined) {
			delete (json as any)[property];
		} else {
			(json as any)[property] = action.value;
		}
	} else {
		for (let i = action.actions.length - 1; i >= 0; i--) {
			const arrayAction = action.actions[i];
			if ('deleteCount' in arrayAction) {
				(json as any)[property].splice(arrayAction.index, arrayAction.deleteCount);
			} else if ('values' in arrayAction) {
				(json as any)[property].splice(arrayAction.index, 0, ...arrayAction.values);
			} else {
				(json as any)[property].splice(arrayAction.index, 0, arrayAction.value);
			}
		}
	}
}

function applyReversals(json: JSObject | JSType[], reversal: Reversal) {
	for (const key of Object.keys(reversal)) {
		const item = reversal[key];
		if (item.__action__) {
			applyAction(json, item as ReversalAction, key);
		} else {
			applyReversals((json as any)[key], item as Reversal);
		}
	}
}

export class History {
	protected blockNumber: number | undefined;
	protected blockHash: string | undefined;
	constructor(protected historyJSON: HistoryJSObject, protected finality: number) {}

	setBlock(blockNumber: number, blockHash: string) {
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

	reverseBlock(blockNumber: number, blockHash: string, json: JSObject) {
		if (!this.blockHash) {
			throw new Error(`no blockhash set`);
		}
		applyReversals(json, this.historyJSON.reversals[this.blockHash]);
		delete this.historyJSON.reversals[blockHash];
		delete this.historyJSON.blockHashes[blockNumber];
	}

	setReversal(fieldPath: string[], action: ReversalAction) {
		if (!this.blockHash) {
			throw new Error(`no blockhash set`);
		}
		let reversalPerBlockHash: Reversal = this.historyJSON.reversals[this.blockHash];
		const found = reversalPerBlockHash && getReversal(reversalPerBlockHash, fieldPath);
		if (!found) {
			let rootReversal: Reversal | undefined;
			for (let i = fieldPath.length - 1; i >= 0; i--) {
				const property = fieldPath[i];
				if (property) {
					rootReversal = {[property]: rootReversal || action};
				}
			}
			this.historyJSON.reversals[this.blockHash] = rootReversal as Reversal;
		} else if ('actionField' in found) {
			if (action.__action__ === 'ValueSet') {
				found.parent[found.actionField] = action;
			} else {
				const previousAction = found.parent[found.actionField] as ReversalAction;
				if (previousAction.__action__ === 'ValueSet') {
					throw new Error(`previous action is "ValueSet", new action is ${action.__action__}`);
				} else {
					previousAction.actions.push(...action.actions);
				}
			}
		} else {
			// nothing to do as higher value is already set at that block
		}
	}
}

function isPrimitive(v: any): boolean {
	return typeof v !== 'function' && typeof v !== 'object';
}
function proxify<T extends JSType | JSType[]>(
	object: T,
	rootObject: JSObject,
	fieldPath: string[],
	history: History
): T {
	if (Array.isArray(object)) {
		return new Proxy(object as JSType[], {
			get: arrayGetter(rootObject, fieldPath, history),
			set: setter(fieldPath, history),
			deleteProperty: deleter(fieldPath, history),
		}) as T;
	} else {
		return new Proxy(object as JSObject, {
			get: getter(rootObject, fieldPath, history),
			set: setter(fieldPath, history),
			deleteProperty: deleter(fieldPath, history),
		}) as T;
	}
}

function arrayGetter(
	rootObject: JSObject,
	fieldPath: string[],
	history: History
): (target: JSType[], property: string) => JSType {
	return (target, property) => {
		const value = (target as any)[property];
		if (typeof value === 'function') {
			if (['indexOf', 'find', 'findIndex'].indexOf(property) !== -1) {
				return value;
			}
			if (property === 'push') {
				return (...values: JSType[]) => {
					history.setReversal(fieldPath, {
						__action__: 'ArraySet',
						actions: [{index: target.length, deleteCount: values.length}],
					});
					return target.push(...values);
				};
			} else if (property === 'pop') {
				return () => {
					const value = target.pop();
					if (value) {
						history.setReversal(fieldPath, {
							__action__: 'ArraySet',
							actions: [{index: target.length, values: [value]}],
						});
					}
					return value;
				};
			} else if (property === 'splice') {
				return (start: number, deleteCount?: number, ...items: JSType[]) => {
					if (items && items.length > 0) {
						throw new Error(`splice in proxy do not support items to add yet...`);
					}
					const values = target.slice(start, deleteCount);
					history.setReversal(fieldPath, {
						__action__: 'ArraySet',
						actions: [{index: target.length, values}], // TODO deepCopy
					});
					return values;
				};
			}

			throw new Error(`${property} not implemented in array proxy`);
		}
		if (isPrimitive(value)) {
			return value;
		}
		return proxify(value, rootObject, [...fieldPath, property], history);
	};
}

function getter(
	rootObject: JSObject,
	fieldPath: string[],
	history: History
): (target: JSObject, property: string) => JSType {
	return (target, property) => {
		const value = target[property];
		if (isPrimitive(value)) {
			return value;
		}
		return proxify(value, rootObject, [...fieldPath, property], history);
	};
}
function setter(
	fieldPath: string[],
	history: History
): (target: JSObject | JSType[], property: string, value: JSType) => boolean {
	return (target, property, value) => {
		history.setReversal([...fieldPath, property], {
			__action__: 'ValueSet',
			value: (target as any)[property], // TODO deepCopy
		});
		(target as any)[property] = value;
		return true;
	};
}
function deleter(fieldPath: string[], history: History): (target: JSObject, property: string) => boolean {
	return (target, property) => {
		history.setReversal([...fieldPath, property], {
			__action__: 'ValueSet',
			value: target[property], // TODO deepCopy
		});
		delete target[property];
		return true;
	};
}

export function proxifyJSON<T extends JSObject>(object: T, history: History) {
	return proxify<T>(object, object, [], history);
}
