<script lang="ts">
	import {processor as processorFactory, contractsDataPerChain} from 'event-processor-conquest-eth';
	import {createIndexerFromFactory} from '../lib/blockchain/indexer';
	import IndexerVisuals from '../lib/components/IndexerVisuals.svelte';
	const chainId = '100';
	const {status, state, syncing, initialize} = createIndexerFromFactory(
		processorFactory,
		contractsDataPerChain[chainId],
		chainId
	);
</script>

<IndexerVisuals {status} {state} {syncing} {initialize} {chainId} requireAccounts={false} />
