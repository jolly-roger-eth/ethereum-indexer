<script lang="ts">
	import {processor as processorFactory, contractsData} from 'event-processor-nfts';
	import {createIndexerFromFactory} from '../lib/blockchain/indexer';
	import IndexerVisuals from '../lib/components/IndexerVisuals.svelte';
	const {status, state, syncing, initialize} = createIndexerFromFactory(
		processorFactory,
		contractsData,
		contractsData.chainId
	);
	function initalizeWithAccount(connection) {
		// TODO padStart
		const accountAs32Bytes = `0x000000000000000000000000${connection.accounts[0].slice(2)}` as const;
		return initialize(connection, {
			filters: {
				Transfer: [[accountAs32Bytes], [null, accountAs32Bytes]],
			},
		});
	}
</script>

<IndexerVisuals
	{status}
	{state}
	{syncing}
	initialize={initalizeWithAccount}
	chainId={contractsData.chainId}
	requireAccounts={true}
/>
