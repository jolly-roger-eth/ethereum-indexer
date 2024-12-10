import type {Hex} from 'viem';
import {concatHex, decodeAbiParameters, parseAbiParameters} from 'viem';

// import { DynamicAbiType, StaticAbiType } from "@latticexyz/schema-type/internal";
import type {ResourceType} from '@latticexyz/common';
import {hexToResource} from '@latticexyz/common';
import {
	hexToSchema,
	decodeValue,
	getSchemaTypes,
	getValueSchema,
	getKeySchema,
	decodeKey,
	decodeValueArgs,
	type Schema,
	encodeKey,
} from '@latticexyz/protocol-parser/internal';
import type {SchemaAbiType} from '@latticexyz/schema-type/internal';
import type {Table} from '@latticexyz/config';

export type {Table};

type DeepWriteable<T> = {-readonly [P in keyof T]: DeepWriteable<T[P]>};

export type TableSchema = DeepWriteable<Pick<Table, 'schema' | 'key'>>;

export const TablesTable: TableSchema = {
	schema: {
		tableId: {
			type: 'bytes32',
			internalType: 'ResourceId',
		},
		fieldLayout: {
			type: 'bytes32',
			internalType: 'FieldLayout',
		},
		keySchema: {
			type: 'bytes32',
			internalType: 'Schema',
		},
		valueSchema: {
			type: 'bytes32',
			internalType: 'Schema',
		},
		abiEncodedKeyNames: {
			type: 'bytes',
			internalType: 'bytes',
		},
		abiEncodedFieldNames: {
			type: 'bytes',
			internalType: 'bytes',
		},
	},
	key: ['tableId'],
};

export function getSchema(tableSchema: TableSchema) {
	const keySchema = getSchemaTypes(getKeySchema(tableSchema as unknown as Pick<Table, 'schema' | 'key'>));
	const valueSchema = getSchemaTypes(getValueSchema(tableSchema as unknown as Pick<Table, 'schema' | 'key'>));

	return {keySchema, valueSchema};
}

export function logToRecord({tableSchema, log}: {tableSchema: TableSchema; log: any}): any {
	const keySchema = getSchemaTypes(getKeySchema(tableSchema as unknown as Pick<Table, 'schema' | 'key'>));
	const valueSchema = getSchemaTypes(getValueSchema(tableSchema as unknown as Pick<Table, 'schema' | 'key'>));
	const key = decodeKey(keySchema, log.args.keyTuple);
	const value = decodeValueArgs(valueSchema, log.args);
	return {...key, ...value};
}

export function recordToTableDefinition(record: {
	abiEncodedFieldNames: Hex;
	abiEncodedKeyNames: Hex;
	fieldLayout: Hex;
	keySchema: Hex;
	tableId: Hex;
	valueSchema: Hex;
}): TableSchema {
	// const keySchema = hexToSchema(record.keySchema);
	// const valueSchema = hexToSchema(record.valueSchema);
	// const keyNames = decodeAbiParameters(parseAbiParameters('string[]'), record.abiEncodedKeyNames)[0] as string[];
	// const fieldNames = decodeAbiParameters(parseAbiParameters('string[]'), record.abiEncodedFieldNames)[0] as string[];
	// // return {
	// // 	keySchema,
	// // 	valueSchema,
	// // 	keyNames,
	// // 	fieldNames,
	// // };

	// const schema = {};

	// for ()

	// return {
	// 	schema,
	// 	key: keyNames,
	// };

	const solidityKeySchema = hexToSchema(record.keySchema);
	const solidityValueSchema = hexToSchema(record.valueSchema);
	const keyNames = decodeAbiParameters(parseAbiParameters('string[]'), record.abiEncodedKeyNames)[0] as string[];
	const fieldNames = decodeAbiParameters(parseAbiParameters('string[]'), record.abiEncodedFieldNames)[0];

	const valueAbiTypes = [...solidityValueSchema.staticFields, ...solidityValueSchema.dynamicFields];

	const keySchema = Object.fromEntries(
		solidityKeySchema.staticFields.map((abiType, i) => [keyNames[i], {type: abiType, internalType: abiType}]),
	);

	const valueSchema = Object.fromEntries(
		valueAbiTypes.map((abiType, i) => [fieldNames[i], {type: abiType, internalType: abiType}]),
	);

	return {
		schema: {
			...valueSchema,
			...keySchema,
		},
		key: keyNames,
	};
}

export type TableInfo = {
	name: string;
	type: string;
	namespace: string;
};

export function extractTableInfo(resourceId: `0x${string}`): TableInfo {
	const hexWithoutPrefix = resourceId.slice(2); // Remove '0x' prefix

	function extractAscii(hex: string): string {
		return (
			hex
				.match(/.{2}/g)
				?.map((byte) => String.fromCharCode(parseInt(byte, 16)))
				.join('')
				.replace(/\x00/g, '') || ''
		);
	}

	const type = extractAscii(hexWithoutPrefix.slice(0, 4));
	const namespace = extractAscii(hexWithoutPrefix.slice(4, 32));
	const name = extractAscii(hexWithoutPrefix.slice(32, 64));

	return {type, namespace, name};
}
