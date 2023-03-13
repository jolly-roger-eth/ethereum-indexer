<script lang="ts">
	import {processor as processorFactory, contractsData} from 'event-processor-nfts';
	import {createIndexerFromFactory} from '../lib/blockchain/indexer';
	import IndexerButton from '../lib/components/IndexerButton.svelte';
	import IndexerProgress from '../lib/components/IndexerProgress.svelte';
	import IndexerStatus from '../lib/components/IndexerStatus.svelte';
	const {status, state, syncing, initialize} = createIndexerFromFactory(
		processorFactory,
		contractsData,
		contractsData.chainId
	);
	function initalizeWithAccount(connection) {
		// TODO padStart
		const accountAs32Bytes = `0x000000000000000000000000${connection.accounts[0].slice(2)}` as const;
		return initialize(connection, {
			parseConfig: {
				filters: {
					Transfer: [[accountAs32Bytes], [null, accountAs32Bytes]],
				},
			},
			processorConfig: {account: connection.accounts[0]},
		});
	}
</script>

<IndexerButton initialize={initalizeWithAccount} chainId={contractsData.chainId} requireAccounts={false} />
<IndexerProgress {syncing} />
<IndexerStatus {status} {state} {syncing} />
