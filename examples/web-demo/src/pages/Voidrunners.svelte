<script lang="ts">
	import {processor, contractsData} from 'event-processor-voidrunners';
	import {createIndexeInitializer} from '../lib/blockchain/indexer';
	import IndexerButton from '../lib/components/IndexerButton.svelte';
	import IndexerProgress from '../lib/components/IndexerProgress.svelte';
	const {state, syncing, initialize} = createIndexeInitializer(processor, contractsData, contractsData[0].chainId);
</script>

<IndexerButton {initialize} chainId={contractsData[0].chainId} accountsToUse={false} />
<IndexerProgress {syncing} />

{#each $state.spaceships as spaceship}
	<p>{spaceship.tokenID}</p>
{/each}
