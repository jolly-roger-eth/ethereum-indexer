<script lang="ts">
	import type {EIP1193Provider} from 'eip-1193';
	import {processorFactory, contractsData, initialFactory} from '../lib/blockchain/nftProcessor';
	import {onMount} from 'svelte';
	import {params} from '../config';
	import type {ActiveConnection} from '../lib/blockchain/connection';
	import {createIndexeInitializer} from '../lib/blockchain/indexer';
	import IndexerButton from '../lib/components/IndexerButton.svelte';
	import IndexerProgress from '../lib/components/IndexerProgress.svelte';
	import NftGallery from '../lib/components/NFTGallery.svelte';

	let accountsToUse: `0x${string}` | boolean = true;
	onMount(() => {
		accountsToUse = (params['account'] as `0x${string}`) || true;
		console.log({accountsToUse});
	});
	const latestContractsData = {
		...contractsData,
		// startBlock: 14432000,
	};
	const initialProcessor = initialFactory();
	const {state, status, syncing, initialize, updateProcessor, updateIndexer} = createIndexeInitializer(
		'mynfts',
		initialProcessor,
		latestContractsData,
		undefined
	);

	let runningProcessor = initialProcessor;
	let firstTime = true;
	processorFactory.subscribe(async (v) => {
		if (firstTime) {
			// skip first as we do not care and the processor is not ready by then
			// TODO throw if processor not ready ?
			firstTime = false;
			return;
		}
		try {
			const newProcessor = v();
			(newProcessor as any).copyFrom && (newProcessor as any).copyFrom(runningProcessor);
			updateProcessor(newProcessor);
			runningProcessor = newProcessor;
		} catch (err) {
			console.error(err);
		}
	});

	let provider: EIP1193Provider | undefined;
	let etherscanURL: string | undefined = undefined;
	function initalizeWithAccount(connection: ActiveConnection) {
		connection.ethereum.on('chainChanged', (chainIdAsHex) => {
			const newChainId = parseInt(chainIdAsHex.slice(2), 16).toString();
			updateIndexer({
				source: {contracts: latestContractsData, chainId: newChainId},
			});
		});
		provider = connection.ethereum;
		etherscanURL =
			connection.chainId === '1'
				? 'https://etherscan.io'
				: connection.chainId === '42161'
				? 'https://arbiscan.io'
				: undefined;
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

<IndexerButton initialize={initalizeWithAccount} {accountsToUse} />
<IndexerProgress {syncing} />
<!-- <IndexerStatus {status} {syncing} /> -->

<NftGallery {state} {provider} {etherscanURL} />
