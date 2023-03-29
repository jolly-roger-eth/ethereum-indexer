<script lang="ts">
	import type {EIP1193Provider} from 'eip-1193';
	import {createProcessor, contractsData} from 'event-processor-bleeps';
	import {derived} from 'svelte/store';
	import type {ActiveConnection} from '../lib/blockchain/connection';
	import {createIndexeInitializer} from '../lib/blockchain/indexer';
	import IndexerButton from '../lib/components/IndexerButton.svelte';
	import IndexerProgress from '../lib/components/IndexerProgress.svelte';
	import NftGallery from '../lib/components/NFTGallery.svelte';
	const {state, syncing, initialize} = createIndexeInitializer(
		'bleeps',
		createProcessor(),
		contractsData,
		contractsData[0].chainId
	);

	let provider: EIP1193Provider | undefined;
	let etherscanURL: string | undefined = undefined;
	function init(connection: ActiveConnection) {
		provider = connection.ethereum;
		etherscanURL =
			connection.chainId === '1'
				? 'https://etherscan.io'
				: connection.chainId === '42161'
				? 'https://arbiscan.io'
				: undefined;
		return initialize(connection);
	}

	const nfts = derived(state, ($state) => ({
		nfts: $state.bleeps.map((v) => ({
			tokenAddress: contractsData[0].address,
			tokenID: v.tokenID,
		})),
	}));
</script>

<IndexerButton initialize={init} chainId={contractsData[0].chainId} accountsToUse={false} />
<IndexerProgress {syncing} />
<!-- {#each $nfts.nfts as bleep}
	<p>MFT {bleep.tokenID}</p>
{/each}

{#each $state.bleeps as bleep}
	<p>{bleep.tokenID}</p>
{/each} -->

<NftGallery title="The Bleeps" state={nfts} {provider} {etherscanURL} />
