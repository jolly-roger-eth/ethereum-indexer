<script lang="ts">
	import {processor as processorFactory, contractsDataPerChain} from 'event-processor-conquest-eth';
	import {createIndexerFromFactory} from '../lib/blockchain/indexer';
	import IndexerButton from '../lib/components/IndexerButton.svelte';
	import IndexerProgress from '../lib/components/IndexerProgress.svelte';
	import IndexerStatus from '../lib/components/IndexerStatus.svelte';
	import IndexerVisuals from '../lib/components/IndexerStatus.svelte';
	const chainId = '100';
	const {status, state, syncing, initialize} = createIndexerFromFactory(
		processorFactory,
		contractsDataPerChain[chainId],
		chainId
	);
</script>

<IndexerButton {initialize} {chainId} requireAccounts={false} />
<IndexerProgress {syncing} />
<IndexerStatus {status} {state} {syncing} />
