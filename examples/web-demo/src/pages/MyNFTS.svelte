<script lang="ts">
	import type {EIP1193Provider} from 'eip-1193';
	import {processor as processorFactory, contractsData} from 'event-processor-nfts';
	import type {ActiveConnection} from '../lib/blockchain/connection';
	import {createIndexerFromFactory} from '../lib/blockchain/indexer';
	import IndexerButton from '../lib/components/IndexerButton.svelte';
	import IndexerProgress from '../lib/components/IndexerProgress.svelte';
	import NftGallery from '../lib/components/NFTGallery.svelte';
	const latestContractsData = {
		...contractsData,
		// startBlock: 14432000,
	};
	const {state, syncing, initialize} = createIndexerFromFactory(processorFactory, latestContractsData, undefined);
	let provider: EIP1193Provider | undefined;
	let etherscanURL: string | undefined = undefined;
	function initalizeWithAccount(connection: ActiveConnection) {
		provider = connection.ethereum;
		etherscanURL = connection.chainId === '1' ? 'https://etherscan.io' : undefined;
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

<IndexerButton initialize={initalizeWithAccount} accountsToUse={true} />
<IndexerProgress {syncing} />
<!-- <IndexerStatus {status} {syncing} /> -->

<NftGallery {state} {provider} {etherscanURL} />
