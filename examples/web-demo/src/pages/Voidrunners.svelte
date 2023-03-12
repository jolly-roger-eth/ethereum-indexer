<script lang="ts">
	import {processor as processorFactory, contractsData} from 'event-processor-voidrunners';
	import {createIndexerFromFactory} from '../lib/blockchain/indexer';
	import IndexerVisuals from '../lib/components/IndexerVisuals.svelte';
	const {status, state, syncing, initialize} = createIndexerFromFactory(
		processorFactory,
		contractsData,
		contractsData[0].chainId
	);
</script>

<IndexerVisuals {status} {state} {syncing} {initialize} chainId={contractsData[0].chainId} requireAccounts={false} />
