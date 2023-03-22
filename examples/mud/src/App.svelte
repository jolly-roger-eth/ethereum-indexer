<script lang="ts">
	import {fromJSProcessor, type JSProcessor} from 'ethereum-indexer-js-processor';
	import {createIndexerState} from 'ethereum-indexer-browser';
	import {connect} from './lib/utils/web3';
	import {parseAbi} from 'viem';

	const chainId = '4242';

	// we need the contract info
	// the abi will be used by the processor to have its type generated, allowing you to get type-safety
	// the adress will be given to the indexer, so it index only this contract
	// the startBlock field allow to tell the indexer to start indexing from that point only
	// here it is the block at which the contract was deployed
	const contract = {
		abi: parseAbi([
			'event ComponentValueSet(uint256 indexed componentId, address indexed component, uint256 indexed entity, bytes data)',
			'event ComponentValueRemoved(uint256 indexed componentId, address indexed component, uint256 indexed entity)',
		]),
		address: '0xCceC5dFc845AdF8C4a1468A29E504059383503aF',
		startBlock: 9045311,
	} as const;

	// we define the type of the state computed by the processor
	// we can also declare it inline in the generic type of JSProcessor
	type State = {
		entities: {
			id: bigint;
			components: {id: bigint; value: `0x${string}`}[];
		}[];
	};

	// the processor is given the type of the ABI as Generic type to get generated
	// it also specify the type which represent the current state
	const processor: JSProcessor<typeof contract.abi, State> = {
		construct() {
			return {entities: []};
		},
		// each event has an associated on<EventName> function which is given both the current state and the typed event
		// each event's argument can be accessed via the `args` field
		// it then modify the state as it wishes
		onComponentValueSet(state, event) {
			const entityFound = state.entities.find((v) => v.id === event.args.entity);
			if (entityFound) {
				const componentFound = entityFound.components.find((v) => v.id === event.args.componentId);
				// TODO parse event.args.data
				if (componentFound) {
					componentFound.value = event.args.data;
				} else {
					entityFound.components.push({id: event.args.componentId, value: event.args.data});
				}
			} else {
				state.entities.push({
					id: event.args.entity,
					components: [{id: event.args.componentId, value: event.args.data}],
				});
			}
		},
		onComponentValueRemoved(state, event) {
			const entityFound = state.entities.find((v) => v.id === event.args.entity);
			if (entityFound) {
				const componentIndexFound = entityFound.components.findIndex((v) => v.id === event.args.componentId);
				if (componentIndexFound !== -1) {
					entityFound.components.splice(componentIndexFound, 1);
				} else {
					console.error(`component ${event.args.componentId} not found on entity ${event.args.entity}`);
				}
			} else {
				console.error(`entity not found with id ${event.args.entity}`);
			}
		},
	};

	// we setup the indexer via a call to `createIndexerState`
	// this setup a set of observable (subscribe pattern)
	// including one for the current state (computed by the processor above)
	// and one for the syncing status
	const {init, state, syncing, startAutoIndexing} = createIndexerState(fromJSProcessor(processor)());

	// we now need to get a handle on a ethereum provider
	// for this app we are simply using window.ethereum
	const ethereum = (window as any).ethereum;

	if (ethereum) {
		// here we first connect it to the chain of our choice and then initialise the indexer
		connect(ethereum, {
			chain: {
				chainId,
				chainName: 'lattice testnet',
				rpcUrls: ['https://follower.testnet-chain.linfra.xyz'],
				nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
				blockExplorerUrls: null, //[],
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
				// config: {stream: {parse: {globalABI: true}}},
			}).then(() => {
				// this automatically index on a timer
				// alternatively you can call `indexMore` or `indexMoreAndCatchupIfNeeded`, both available from the return value of `createIndexerState`
				// startAutoIndexing is easier but manually calling `indexMore` or `indexMoreAndCatchupIfNeeded` is better
				// this is because you can call them for every `newHeads` eth_subscribe message
				startAutoIndexing();
			});
		});
	}
</script>

{#if !ethereum}
	<p>To test this app, you need to have a ethereum wallet installed</p>
{:else}
	<div>
		<h1>In-Browser Indexer</h1>
		<p>{$syncing.lastSync?.syncPercentage || 0}</p>
		{#if $syncing.lastSync}
			<progress value={($syncing.lastSync.syncPercentage || 0) / 100} style="width: '100%';" />
		{:else}
			<p>Please wait...</p>
		{/if}
		<div>
			{#each $state.entities as entity (entity.id)}
				<p>{entity.id} has {entity.components.length} components</p>
			{/each}
		</div>
	</div>
{/if}
