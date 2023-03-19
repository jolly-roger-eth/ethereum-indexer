function normalizeAsArray(obj: object): any {
	if (obj === null) {
		return null;
	}
	if (Array.isArray(obj)) {
		return obj.map((v) => normalizeAsArray(v));
	} else if (typeof obj === 'object') {
		const arr = [];
		const keys = Object.keys(obj).sort();
		for (const key of keys) {
			const value = (obj as any)[key];
			if (value) {
				arr.push([key, normalizeAsArray(value)]);
			}
		}
		return arr;
	} else {
		return obj;
	}
}
export function hash(obj: any): string {
	const str = typeof obj === 'string' ? obj : JSON.stringify(normalizeAsArray(obj as object)).replace(/\s+/g, '');
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		const char = str.charCodeAt(i);
		hash = (hash << 5) - hash + char;
		hash &= hash; // Convert to 32bit integer
	}
	const result = new Uint32Array([hash])[0].toString(36);
	return result;
}
