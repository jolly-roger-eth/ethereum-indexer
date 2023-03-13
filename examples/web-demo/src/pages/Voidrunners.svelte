<script lang="ts">
	import {processor as processorFactory, contractsData} from 'event-processor-voidrunners';
	import {createIndexerFromFactory} from '../lib/blockchain/indexer';
	import IndexerButton from '../lib/components/IndexerButton.svelte';
	import IndexerProgress from '../lib/components/IndexerProgress.svelte';
	import IndexerStatus from '../lib/components/IndexerStatus.svelte';
	const {status, state, syncing, initialize} = createIndexerFromFactory(
		processorFactory,
		contractsData,
		contractsData[0].chainId
	);
</script>

<IndexerButton {initialize} chainId={contractsData[0].chainId} requireAccounts={false} />
<IndexerProgress {syncing} />
<IndexerStatus {status} {state} {syncing} />
