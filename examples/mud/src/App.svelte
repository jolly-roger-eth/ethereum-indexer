<script lang="ts">
	import './App.css';
	import {fromJSProcessor, type JSProcessor} from 'ethereum-indexer-js-processor';
	import {createIndexerState, keepStateOnIndexedDB} from 'ethereum-indexer-browser';
	import {connect} from './lib/utils/web3';
	import {parseAbi} from 'viem';

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

	type State = {
		records: {[key: Hex]: Record};
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

	// the processor is given the type of the ABI as Generic type to get generated
	// it also specify the type which represent the current state
	const processor: JSProcessor<typeof contract.abi, State> = {
		// you can set a version, ideally you would generate it so that it changes for each change
		// when a version changes, the indexer will detect that and clear the state
		// if it has the event stream cached, it will repopulate the state automatically
		version: '1.0.2',
		// this function set the starting state
		// this allow the app to always have access to a state, no undefined needed
		construct() {
			return {records: {}};
		},
		// each event has an associated on<EventName> function which is given both the current state and the typed event
		// each event's argument can be accessed via the `args` field
		// it then modify the state as it wishes
		onStore_SetRecord(state, event) {
			const key = storeKey(event.args.tableId, event.args.keyTuple);

			// Overwrite all of the Record's fields
			state.records[key] = {
				staticData: event.args.staticData,
				encodedLengths: event.args.encodedLengths,
				dynamicData: event.args.dynamicData,
			};
		},
		onStore_SpliceStaticData(state, event) {
			const key = storeKey(event.args.tableId, event.args.keyTuple);
			const record = state.records[key] ?? {
				staticData: '0x',
				encodedLengths: '0x',
				dynamicData: '0x',
			};

			// Splice the static field data of the Record
			state.records[key] = {
				staticData: bytesSplice(record.staticData, event.args.start, bytesLength(event.args.data), event.args.data),
				encodedLengths: record.encodedLengths,
				dynamicData: record.dynamicData,
			};
		},

		onStore_SpliceDynamicData(state, event) {
			const key = storeKey(event.args.tableId, event.args.keyTuple);
			const record = state.records[key] ?? {
				staticData: '0x',
				encodedLengths: '0x',
				dynamicData: '0x',
			};

			// Splice the dynamic field data of the Record
			state.records[key] = {
				staticData: record.staticData,
				encodedLengths: event.args.encodedLengths,
				dynamicData: bytesSplice(record.dynamicData, event.args.start, event.args.deleteCount, event.args.data),
			};
		},
		onStore_DeleteRecord(state, event) {
			const key = storeKey(event.args.tableId, event.args.keyTuple);

			// Delete the whole Record
			delete state.records[key];
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

	$: recordKeys = Object.keys($state.records) as `0x${string}`[];
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
				<span>{key} </span> <span>{JSON.stringify($state.records[key], null, 2)}</span>
			{/each}
		</div>
	{/if}
</div>
