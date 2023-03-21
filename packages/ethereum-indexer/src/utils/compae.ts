export function deepEqual(a: unknown, b: unknown): boolean {
	if (typeof a == 'object' && a != null && typeof b == 'object' && b != null) {
		let numKeysInA = 0;
		let numKeysinB = 0;
		for (const key in a) {
			numKeysInA++;
		}
		for (const key in b) {
			numKeysinB++;
		}
		if (numKeysInA !== numKeysinB) {
			return false;
		}
		for (const key in a) {
			if (!(key in b) || !deepEqual((a as any)[key], (b as any)[key])) {
				return false;
			}
		}
		for (const key in b) {
			if (!(key in a) || !deepEqual((b as any)[key], (a as any)[key])) {
				return false;
			}
		}
		return true;
	} else {
		return a === b;
	}
}
