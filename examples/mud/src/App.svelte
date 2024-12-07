<script lang="ts">
	import './App.css';
	import {fromJSProcessor, type JSProcessor, type JSType} from 'ethereum-indexer-js-processor';
	import {createIndexerState, keepStateOnIndexedDB} from 'ethereum-indexer-browser';
	import {connect} from './lib/utils/web3';
	import {parseAbi, decodeAbiParameters} from 'viem';

	const chainId = '690';

	// we need the contract info
	// the abi will be used by the processor to have its type generated, allowing you to get type-safety
	// the adress will be given to the indexer, so it index only this contract
	// the startBlock field allow to tell the indexer to start indexing from that point only
	// here it is the block at which the contract was deployed
	const contract = {
		abi: parseAbi([
			'event Store_SetRecord(bytes32 indexed tableId, bytes32[] keyTuple, bytes staticData, bytes32 encodedLengths, bytes dynamicData)',
			'event Store_SpliceStaticData(bytes32 indexed tableId, bytes32[] keyTuple, uint48 start, bytes data)',
			'event Store_SpliceDynamicData(bytes32 indexed tableId, bytes32[] keyTuple, uint8 dynamicFieldIndex, uint48 start, uint40 deleteCount, bytes32 encodedLengths, bytes data)',
			'event Store_DeleteRecord(bytes32 indexed tableId, bytes32[] keyTuple)',
		]),
		address: '0xF75b1b7bDB6932e487c4aA8d210F4A682ABeAcf0', // Biomes AW
		startBlock: 1079762,
	} as const;

	// we define the type of the state computed by the processor
	// we can also declare it inline in the generic type of JSProcessor

	type Hex = `0x${string}`;

	type Record = {
		staticData: Hex;
		encodedLengths: Hex;
		dynamicData: Hex;
	};

	type TableRecord = {
		fieldLayout: ReturnType<typeof parseFieldLayout>;
		keySchema: ReturnType<typeof parseSchema>;
		valueSchema: ReturnType<typeof parseSchema>;
		keyNames: string[];
		fieldNames: string[];
	};

	type State = {
		tables: {[key: string]: JSType[]};
		tableDefinitions: {[name: string]: TableRecord};
	};

	// Create a key string from a table ID and key tuple to use in our store Map above
	function storeKey(tableId: Hex, keyTuple: readonly Hex[]): `0x${string}` {
		return `${tableId}:${keyTuple.join(',')}`;
	}

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

	function parseSchema(schemaBytes: string): {
		staticFieldsLength: number;
		staticFieldsCount: number;
		dynamicFieldsCount: number;
		fieldTypes: SchemaType[];
	} {
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

	function parseEncodedLengths(encodedLengthsHex: string): number[] {
		const encodedLengths = BigInt(`0x${encodedLengthsHex}`);
		const totalDynamicLength = Number(encodedLengths & BigInt('0xffffffffffffff')); // 56 bits
		const lengths = [totalDynamicLength];

		for (let i = 0; i < 5; i++) {
			const length = Number((encodedLengths >> BigInt(56 + i * 40)) & BigInt('0xffffffffff')); // 40 bits each
			if (length > 0) lengths.push(length);
		}

		return lengths;
	}

	function parseFieldLayout(fieldLayoutBytes: string): {
		staticFieldsLength: number;
		staticFieldsCount: number;
		dynamicFieldsCount: number;
		staticFieldLengths: number[];
	} {
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

	function parseTablesRecord(data: {staticData: string; encodedLengths: string; dynamicData: string}): TableRecord {
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

	function extractTableInfo(resourceId: `0x${string}`) {
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

	// the processor is given the type of the ABI as Generic type to get generated
	// it also specify the type which represent the current state
	const processor: JSProcessor<typeof contract.abi, State> = {
		// you can set a version, ideally you would generate it so that it changes for each change
		// when a version changes, the indexer will detect that and clear the state
		// if it has the event stream cached, it will repopulate the state automatically
		version: '1.0.15',
		// this function set the starting state
		// this allow the app to always have access to a state, no undefined needed
		construct() {
			return {tables: {}, tableDefinitions: {}};
		},
		// each event has an associated on<EventName> function which is given both the current state and the typed event
		// each event's argument can be accessed via the `args` field
		// it then modify the state as it wishes
		onStore_SetRecord(state, event) {
			const key = storeKey(event.args.tableId, event.args.keyTuple);

			const tableInfo = extractTableInfo(event.args.tableId);

			if (tableInfo.namespace == 'store' && tableInfo.name === 'Tables') {
				const registeredTableId = event.args.keyTuple[0];
				const registeredTableInfo = extractTableInfo(registeredTableId);
				const parsedTable = parseTablesRecord(event.args);
				console.log({...registeredTableInfo, ...event.args, parsedTable});
				// const fieldLayour = event.args.

				// TODO registeredTableInfo.type
				const registeredTableNameId = registeredTableInfo.namespace + '_' + registeredTableInfo.name;
				const existingTable = state.tableDefinitions[registeredTableNameId];
				if (existingTable) {
					throw new Error(`invalid world, table registered twice`);
				}
				state.tableDefinitions[registeredTableNameId] = parsedTable;
			} else {
				const tableNameId = tableInfo.namespace + '_' + tableInfo.name;
				const table = state.tableDefinitions[tableNameId];
				if (!table) {
					throw new Error(`invalid world, table not registered before use`);
				}
				const row: JSType = {};

				let i = 0;
				for (const keyName of table.keyNames) {
					if (i < table.keySchema.staticFieldsCount) {
						const type = table.keySchema.fieldTypes[i];
						row[keyName] = event.args.staticData; // TODO based on type
					}
					// no dynamic data for keys
					i++;
				}

				i = 0;
				for (const fieldName of table.fieldNames) {
					if (i < table.valueSchema.staticFieldsCount) {
						const type = table.valueSchema.fieldTypes[i];
						row[fieldName] = event.args.staticData; // TODO based on type
					} else {
						// TODO dynamic fields
					}
					i++;
				}
				state.tables[tableNameId] = state.tables[tableNameId] || [];
				state.tables[tableNameId].push(row);
			}

			// if (BigInt(event.args.tableId) >> 240n == 0x6f74n) {
			// 	console.log(`offchain table: ${tableInfo.name} (${tableInfo.namespace})`);
			// } else {
			// 	console.log(`onchain table: ${tableInfo.name} (${tableInfo.namespace})`);
			// }

			// // Overwrite all of the Record's fields
			// state.records[key] = {
			// 	staticData: event.args.staticData,
			// 	encodedLengths: event.args.encodedLengths,
			// 	dynamicData: event.args.dynamicData,
			// };

			// if (event.args.tableId === '0x746273746f72650000000000000000005461626c657300000000000000000000') {
			// }
		},
		onStore_SpliceStaticData(state, event) {
			// const key = storeKey(event.args.tableId, event.args.keyTuple);
			// const record = state.tables[key] ?? {
			// 	staticData: '0x',
			// 	encodedLengths: '0x',
			// 	dynamicData: '0x',
			// };
			// Splice the static field data of the Record
			// state.records[key] = {
			// 	raw: {
			// 		staticData: bytesSplice(
			// 			record.raw.staticData,
			// 			event.args.start,
			// 			bytesLength(event.args.data),
			// 			event.args.data,
			// 		),
			// 		encodedLengths: record.raw.encodedLengths,
			// 		dynamicData: record.raw.dynamicData,
			// 	},
			// 	row: {}
			// };
		},

		onStore_SpliceDynamicData(state, event) {
			// const key = storeKey(event.args.tableId, event.args.keyTuple);
			// const record = state.tables[key] ?? {
			// 	staticData: '0x',
			// 	encodedLengths: '0x',
			// 	dynamicData: '0x',
			// };
			// Splice the dynamic field data of the Record
			// state.records[key] = {
			// 	raw: {
			// 		staticData: record.raw.staticData,
			// 		encodedLengths: event.args.encodedLengths,
			// 		dynamicData: bytesSplice(record.raw.dynamicData, event.args.start, event.args.deleteCount, event.args.data),
			// 	},
			// 	row: {}
			// };
		},
		onStore_DeleteRecord(state, event) {
			// const key = storeKey(event.args.tableId, event.args.keyTuple);
			// // Delete the whole Record
			// delete state.records[key];
		},
	};

	// we setup the indexer via a call to `createIndexerState`
	// this setup a set of observable (subscribe pattern)
	// including one for the current state (computed by the processor above)
	// and one for the syncing status
	const {init, state, syncing, startAutoIndexing} = createIndexerState(fromJSProcessor(processor)(), {
		// here we tell it to save the state on indexed db
		// you can try changing the version string of the processor and the state will be discarded
		keepState: keepStateOnIndexedDB('basic') as any,
	});

	// we now need to get a handle on a ethereum provider
	// for this app we are simply using window.ethereum
	const ethereum = (window as any).ethereum;

	// but to not trigger a metamask popup right away we wrap that in a function to be called via a click of a button
	function start() {
		if (ethereum) {
			// here we first connect it to the chain of our choice and then initialise the indexer
			connect(ethereum, {
				chain: {
					chainId,
					chainName: 'lattice testnet',
					rpcUrls: ['https://follower.testnet-chain.linfra.xyz'],
					nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
					blockExplorerUrls: [],
				},
			}).then(({ethereum}) => {
				// we already setup the processor
				// now we need to initialise the indexer with
				// - an EIP-1193 provider (window.ethereum here)
				// - source config which includes the chainId and the list of contracts (abi,address. startBlock)
				// here we also configure so the indexer uses ABI as global so events defined across contracts will be processed
				init({
					provider: ethereum,
					source: {chainId, contracts: [contract]},
				}).then(() => {
					// this automatically index on a timer
					// alternatively you can call `indexMore` or `indexMoreAndCatchupIfNeeded`, both available from the return value of `createIndexerState`
					// startAutoIndexing is easier but manually calling `indexMore` or `indexMoreAndCatchupIfNeeded` is better
					// this is because you can call them for every `newHeads` eth_subscribe message
					startAutoIndexing();
				});
			});
		}
	}

	$: recordKeys = (Object.keys($state.tables) as `0x${string}`[]).slice(0, 10);
</script>

<div class="App">
	<h1>Indexing a <a href="https://mud.dev" target="_blank" rel="noreferrer">MUD</a> World</h1>
	{#if !ethereum}
		<p>To test this app, you need to have a ethereum wallet installed</p>
	{:else if $syncing.waitingForProvider}
		<button on:click={start} style="background-color: #45ffbb; color: black;">Start</button>
	{:else}
		<p>{$syncing.lastSync?.syncPercentage || 0}</p>
		{#if $syncing.lastSync}
			<progress value={($syncing.lastSync.syncPercentage || 0) / 100} style="width: 100%" />
		{:else}
			<p>Please wait...</p>
		{/if}
		<div>
			{#each recordKeys as key (key)}
				<span>{key} </span> <span>{JSON.stringify($state.tables[key][0], null, 2)}</span>
				<hr />
			{/each}
		</div>
	{/if}
</div>
