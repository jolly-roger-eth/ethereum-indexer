<script lang="ts">
	import './App.css';
	import {fromJSProcessor, type JSProcessor, type JSType} from 'ethereum-indexer-js-processor';
	import {createIndexerState, keepStateOnIndexedDB} from 'ethereum-indexer-browser';
	import {connect} from './lib/utils/web3';
	import {parseAbi, type Hex} from 'viem';
	import {extractTableInfo, parseTablesRecord, type TableRecord} from './lib/utils/mud';

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
	type State = {
		tables: {[key: string]: JSType[]};
		tableDefinitions: {[name: string]: TableRecord};
	};

	// Create a key string from a table ID and key tuple to use in our store Map above
	function storeKey(tableId: Hex, keyTuple: readonly Hex[]): `0x${string}` {
		return `${tableId}:${keyTuple.join(',')}`;
	}

	// the processor is given the type of the ABI as Generic type to get generated
	// it also specify the type which represent the current state
	const processor: JSProcessor<typeof contract.abi, State> = {
		// you can set a version, ideally you would generate it so that it changes for each change
		// when a version changes, the indexer will detect that and clear the state
		// if it has the event stream cached, it will repopulate the state automatically
		version: '1.0.21',
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

				// try {
				// 	const tableDef = logToTable(event);
				// 	console.log('tabledef', {tableDef});
				// } catch (err) {
				// 	console.error(err);
				// }

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
					chainName: 'Redstone',
					rpcUrls: ['https://rpc.redstonechain.com'],
					nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
					blockExplorerUrls: ['https://explorer.redstone.xyz'],
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
