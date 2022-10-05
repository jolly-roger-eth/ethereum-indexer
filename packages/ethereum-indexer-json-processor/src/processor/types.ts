export type JSObject = {
	[key: string]: JSType;
};

export type JSType = string | number | boolean | bigint | JSType[] | JSObject;
