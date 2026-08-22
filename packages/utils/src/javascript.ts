export function filterOutFieldsFromObject<T extends {} = Object, U extends {} = Object>(obj: T, fields: string[]): U {
	const keys = Object.keys(obj);
	const newObj: U = {} as U;
	for (const key of keys) {
		if (fields.includes(key)) {
			continue;
		}
		(newObj as any)[key] = (obj as any)[key];
	}
	return newObj;
}

export function filterOutUnderscoreFieldsFromObject<T extends {} = Object, U extends {} = Object>(obj: T): U {
	const keys = Object.keys(obj);
	const newObj: U = {} as U;
	for (const key of keys) {
		if (key.startsWith('_')) {
			continue;
		}
		(newObj as any)[key] = (obj as any)[key];
	}
	return newObj;
}

export function clean(obj: Object) {
	return filterOutUnderscoreFieldsFromObject(obj);
}

export function removeUndefinedValuesFromObject(obj: any) {
	Object.keys(obj).forEach((key) => (obj[key] === undefined ? delete obj[key] : {}));
	return obj;
}
