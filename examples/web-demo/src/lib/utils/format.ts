export function addLengthToFields(v: any): any {
	const keys = Object.keys(v);
	const n = {};
	for (const key of keys) {
		if (typeof v[key] === 'object') {
			n[key + ` (${Object.keys(v[key]).length})`] = v[key];
		} else {
			n[key] = v[key];
		}
	}
	return n;
}
