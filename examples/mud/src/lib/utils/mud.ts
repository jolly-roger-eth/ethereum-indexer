import type {Hex} from 'viem';
import {concatHex, decodeAbiParameters, parseAbiParameters} from 'viem';

// import { DynamicAbiType, StaticAbiType } from "@latticexyz/schema-type/internal";
import {type ResourceType} from '@latticexyz/common';
import {hexToResource} from '@latticexyz/common';
import {hexToSchema, decodeValue, getSchemaTypes, getValueSchema} from '@latticexyz/protocol-parser/internal';

import {type JSType} from 'ethereum-indexer-js-processor';

export type satisfy<base, t extends base> = t;
// export type AbiType = StaticAbiType | DynamicAbiType;
// export type { StaticAbiType, DynamicAbiType };
// export type Schema = {
//   readonly [fieldName: string]: {
//     /** the Solidity primitive ABI type */
//     readonly type: AbiType;
//     /** the user defined type or Solidity primitive ABI type */
//     readonly internalType: string;
//   };
// };

export type Table = {
	/**
	 * Human-readable label for this table. Used as config keys, library names, and filenames.
	 * Labels are not length constrained like resource names, but special characters should be avoided to be compatible with the filesystem, Solidity compiler, etc.
	 */
	readonly label: string;
	/**
	 * Human-readable label for this table's namespace. Used for namespace config keys and directory names.
	 */
	readonly namespaceLabel: string;
	/**
	 * Table type used in table's resource ID and determines how storage and events are used by this table.
	 */
	readonly type: satisfy<ResourceType, 'table' | 'offchainTable'>;
	/**
	 * Table namespace used in table's resource ID and determines access control.
	 */
	readonly namespace: string;
	/**
	 * Table name used in table's resource ID.
	 */
	readonly name: string;
	/**
	 * Table's resource ID.
	 */
	readonly tableId: Hex;
	/**
	 * Schema definition for this table's records.
	 */
	readonly schema: Schema;
	/**
	 * Primary key for records of this table. An array of zero or more schema field names.
	 * Using an empty array acts like a singleton, where only one record can exist for this table.
	 */
	readonly key: readonly string[];
};

// const TablesValueSchema = {
// 	label: 'Tables',
// 	namespaceLabel: 'store',
// 	type: 'table',
// 	namespace: 'store',
// 	name: 'Tables',
// 	tableId: '0x',
// 	schema: {
// 		tableId: {
// 			type: 'bytes32',
// 			internalType: 'ResourceId',
// 		},
// 		fieldLayout: {
// 			type: 'bytes32',
// 			internalType: 'FieldLayout',
// 		},
// 		keySchema: {
// 			type: 'bytes32',
// 			internalType: 'Schema',
// 		},
// 		valueSchema: {
// 			type: 'bytes32',
// 			internalType: 'Schema',
// 		},
// 		abiEncodedKeyNames: {
// 			type: 'bytes',
// 			internalType: 'bytes',
// 		},
// 		abiEncodedFieldNames: {
// 			type: 'bytes',
// 			internalType: 'bytes',
// 		},
// 	},
// 	key: ['tableId'],
// 	codegen: {
// 		outputDirectory: '',
// 		tableIdArgument: false,
// 		storeArgument: false,
// 		dataStruct: true, // false ?
// 	},
// 	deploy: {
// 		disabled: false,
// 	},
// } as const;

// const schemaTypes = getSchemaTypes(getValueSchema(TablesValueSchema));

// console.log(schemaTypes);

// export function logToTable(log: any): Table {
// 	const [tableId, ...otherKeys] = log.args.keyTuple;
// 	if (otherKeys.length) {
// 		console.warn('registerSchema event is expected to have only one key in key tuple, but got multiple', log);
// 	}

// 	const resource = hexToResource(tableId);

// 	const value = decodeValue(
// 		{
// 			abiEncodedFieldNames: 'bytes',
// 			abiEncodedKeyNames: 'bytes',
// 			fieldLayout: 'bytes32',
// 			keySchema: 'bytes32',
// 			valueSchema: 'bytes32',
// 		},
// 		concatHex([log.args.staticData, log.args.encodedLengths, log.args.dynamicData]),
// 	);

// 	const solidityKeySchema = hexToSchema(value.keySchema);
// 	const solidityValueSchema = hexToSchema(value.valueSchema);
// 	const keyNames = decodeAbiParameters(parseAbiParameters('string[]'), value.abiEncodedKeyNames)[0];
// 	const fieldNames = decodeAbiParameters(parseAbiParameters('string[]'), value.abiEncodedFieldNames)[0];

// 	const valueAbiTypes = [...solidityValueSchema.staticFields, ...solidityValueSchema.dynamicFields];

// 	const keySchema = Object.fromEntries(
// 		solidityKeySchema.staticFields.map((abiType, i) => [keyNames[i], {type: abiType, internalType: abiType}]),
// 	) satisfies Schema;

// 	const valueSchema = Object.fromEntries(
// 		valueAbiTypes.map((abiType, i) => [fieldNames[i], {type: abiType, internalType: abiType}]),
// 	) satisfies Schema;

// 	return {
// 		//   address: log.address,
// 		type: resource.type as never,
// 		namespace: resource.namespace,
// 		label: resource.name, // TODO
// 		namespaceLabel: resource.namespace, // TODO
// 		name: resource.name,
// 		tableId,
// 		schema: {...keySchema, ...valueSchema},
// 		key: Object.keys(keySchema),
// 		//   keySchema: getSchemaTypes(keySchema),
// 		//   valueSchema: getSchemaTypes(valueSchema),
// 	};
// }

export type TableRecord = {
	fieldLayout: FieldLayout;
	keySchema: Schema;
	valueSchema: Schema;
	keyNames: string[];
	fieldNames: string[];
};

type Record = {
	staticData: Hex;
	encodedLengths: Hex;
	dynamicData: Hex;
};

// Like `Array.splice`, but for strings of bytes
function bytesSplice(data: Hex, start: number, deleteCount = 0, newData: Hex = '0x'): Hex {
	const dataNibbles = data.replace(/^0x/, '').split('');
	const newDataNibbles = newData.replace(/^0x/, '').split('');
	return `0x${dataNibbles
		.splice(start, deleteCount * 2)
		.concat(newDataNibbles)
		.join('')}`;
}

function bytesLength(data: Hex): number {
	return data.replace(/^0x/, '').length / 2;
}

// Utility functions
function hexToUint8Array(hex: string): Uint8Array {
	return new Uint8Array(hex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16)));
}

function uint8ArrayToHex(arr: Uint8Array): string {
	return '0x' + Array.from(arr, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function sliceHex(hex: string, start: number, end: number): string {
	return uint8ArrayToHex(hexToUint8Array(hex.slice(2)).slice(start, end));
}

enum SchemaType {
	UINT8 = 0x00,
	UINT16 = 0x01,
	UINT24 = 0x02,
	UINT32 = 0x03,
	UINT40 = 0x04,
	UINT48 = 0x05,
	UINT56 = 0x06,
	UINT64 = 0x07,
	UINT72 = 0x08,
	UINT80 = 0x09,
	UINT88 = 0x0a,
	UINT96 = 0x0b,
	UINT104 = 0x0c,
	UINT112 = 0x0d,
	UINT120 = 0x0e,
	UINT128 = 0x0f,
	UINT136 = 0x10,
	UINT144 = 0x11,
	UINT152 = 0x12,
	UINT160 = 0x13,
	UINT168 = 0x14,
	UINT176 = 0x15,
	UINT184 = 0x16,
	UINT192 = 0x17,
	UINT200 = 0x18,
	UINT208 = 0x19,
	UINT216 = 0x1a,
	UINT224 = 0x1b,
	UINT232 = 0x1c,
	UINT240 = 0x1d,
	UINT248 = 0x1e,
	UINT256 = 0x1f,
	INT8 = 0x20,
	INT16 = 0x21,
	// ... (continue for other int sizes)
	INT256 = 0x3f,
	BYTES1 = 0x40,
	BYTES2 = 0x41,
	// ... (continue for other bytes sizes)
	BYTES32 = 0x5f,
	BOOL = 0x60,
	ADDRESS = 0x61,
	UINT8_ARRAY = 0x62,
	UINT16_ARRAY = 0x63,
	// ... (continue for other uint array sizes)
	UINT256_ARRAY = 0x81,
	INT8_ARRAY = 0x82,
	INT16_ARRAY = 0x83,
	// ... (continue for other int array sizes)
	INT256_ARRAY = 0xa1,
	BYTES1_ARRAY = 0xa2,
	BYTES2_ARRAY = 0xa3,
	// ... (continue for other bytes array sizes)
	BYTES32_ARRAY = 0xc1,
	BOOL_ARRAY = 0xc2,
	ADDRESS_ARRAY = 0xc3,
	BYTES = 0xc4,
	STRING = 0xc5,
}

function decodeSchemaType(typeCode: number): SchemaType {
	if (typeCode >= 0x00 && typeCode <= 0x1f) {
		return SchemaType.UINT8 + typeCode;
	} else if (typeCode >= 0x20 && typeCode <= 0x3f) {
		return SchemaType.INT8 + (typeCode - 0x20);
	} else if (typeCode >= 0x40 && typeCode <= 0x5f) {
		return SchemaType.BYTES1 + (typeCode - 0x40);
	} else if (typeCode >= 0x62 && typeCode <= 0x81) {
		return SchemaType.UINT8_ARRAY + (typeCode - 0x62);
	} else if (typeCode >= 0x82 && typeCode <= 0xa1) {
		return SchemaType.INT8_ARRAY + (typeCode - 0x82);
	} else if (typeCode >= 0xa2 && typeCode <= 0xc1) {
		return SchemaType.BYTES1_ARRAY + (typeCode - 0xa2);
	} else {
		switch (typeCode) {
			case 0x60:
				return SchemaType.BOOL;
			case 0x61:
				return SchemaType.ADDRESS;
			case 0xc2:
				return SchemaType.BOOL_ARRAY;
			case 0xc3:
				return SchemaType.ADDRESS_ARRAY;
			case 0xc4:
				return SchemaType.BYTES;
			case 0xc5:
				return SchemaType.STRING;
			default:
				throw new Error(`Invalid schema type code: ${typeCode}`);
		}
	}
}

export type Schema = {
	staticFieldsLength: number;
	staticFieldsCount: number;
	dynamicFieldsCount: number;
	fieldTypes: SchemaType[];
};

export function parseSchema(schemaBytes: string): Schema {
	const staticFieldsLength = parseInt(schemaBytes.slice(0, 4), 16);
	const staticFieldsCount = parseInt(schemaBytes.slice(4, 6), 16);
	const dynamicFieldsCount = parseInt(schemaBytes.slice(6, 8), 16);
	const fieldTypesHex = schemaBytes.slice(8);

	const fieldTypes: SchemaType[] = [];
	for (let i = 0; i < staticFieldsCount + dynamicFieldsCount; i++) {
		const typeCode = parseInt(fieldTypesHex.slice(i * 2, i * 2 + 2), 16);
		fieldTypes.push(decodeSchemaType(typeCode));
	}

	return {staticFieldsLength, staticFieldsCount, dynamicFieldsCount, fieldTypes};
}

export function parseEncodedLengths(encodedLengthsHex: string): number[] {
	const encodedLengths = BigInt(`0x${encodedLengthsHex}`);
	const totalDynamicLength = Number(encodedLengths & BigInt('0xffffffffffffff')); // 56 bits
	const lengths = [totalDynamicLength];

	for (let i = 0; i < 5; i++) {
		const length = Number((encodedLengths >> BigInt(56 + i * 40)) & BigInt('0xffffffffff')); // 40 bits each
		if (length > 0) lengths.push(length);
	}

	return lengths;
}

export type FieldLayout = {
	staticFieldsLength: number;
	staticFieldsCount: number;
	dynamicFieldsCount: number;
	staticFieldLengths: number[];
};
export function parseFieldLayout(fieldLayoutBytes: string): FieldLayout {
	const staticFieldsLength = parseInt(fieldLayoutBytes.slice(0, 4), 16);
	const staticFieldsCount = parseInt(fieldLayoutBytes.slice(4, 6), 16);
	const dynamicFieldsCount = parseInt(fieldLayoutBytes.slice(6, 8), 16);
	const staticFieldLengthsHex = fieldLayoutBytes.slice(8);

	const staticFieldLengths: number[] = [];
	for (let i = 0; i < staticFieldsCount; i++) {
		staticFieldLengths.push(parseInt(staticFieldLengthsHex.slice(i * 2, i * 2 + 2), 16));
	}

	return {staticFieldsLength, staticFieldsCount, dynamicFieldsCount, staticFieldLengths};
}

export function parseTablesRecord(data: {
	staticData: string;
	encodedLengths: string;
	dynamicData: string;
}): TableRecord {
	// Parse static data
	const fieldLayout = parseFieldLayout(data.staticData.slice(2, 66));
	const keySchema = parseSchema(data.staticData.slice(66, 130));
	const valueSchema = parseSchema(data.staticData.slice(130, 194));

	// Parse encoded lengths
	const dynamicLengths = parseEncodedLengths(data.encodedLengths.slice(2));

	// Parse dynamic data
	const dynamicData = data.dynamicData.slice(2); // Remove '0x' prefix
	let offset = 0;
	const abiEncodedKeyNamesHex = ('0x' + dynamicData.slice(offset, offset + dynamicLengths[1] * 2)) as `0x${string}`;
	offset += dynamicLengths[1] * 2;
	const abiEncodedFieldNamesHex = ('0x' + dynamicData.slice(offset, offset + dynamicLengths[2] * 2)) as `0x${string}`;

	// Decode key names and field names using viem
	const keyNames = decodeAbiParameters([{type: 'string[]'}], abiEncodedKeyNamesHex)[0] as string[];
	const fieldNames = decodeAbiParameters([{type: 'string[]'}], abiEncodedFieldNamesHex)[0] as string[];

	return {
		fieldLayout,
		keySchema,
		valueSchema,
		keyNames,
		fieldNames,
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
