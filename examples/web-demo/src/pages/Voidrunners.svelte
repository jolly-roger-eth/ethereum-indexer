<script lang="ts">
	import {processor, contractsData} from 'event-processor-voidrunners';
	import {createIndexeInitializer} from '../lib/blockchain/indexer';
	import IndexerButton from '../lib/components/IndexerButton.svelte';
	import IndexerProgress from '../lib/components/IndexerProgress.svelte';
	import IndexerStatus from '../lib/components/IndexerStatus.svelte';
	import StateValues from '../lib/components/StateValues.svelte';
	const {status, state, syncing, initialize} = createIndexeInitializer(
		processor,
		contractsData,
		contractsData[0].chainId
	);
</script>

<IndexerButton {initialize} chainId={contractsData[0].chainId} accountsToUse={false} />
<IndexerProgress {syncing} />
<IndexerStatus {status} {syncing} />
<StateValues {state} {syncing} />
