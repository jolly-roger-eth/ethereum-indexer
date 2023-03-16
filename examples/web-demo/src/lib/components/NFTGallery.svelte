<script lang="ts">
	export let state: Readable<Data>;

	import type {Data} from 'event-processor-nfts';
	import type {EIP1193Provider} from 'eip-1193';
	import type {Readable} from 'svelte/store';
	import LoadingNft from './LoadingNFT.svelte';
	import {paginate} from '../utils/pagination';
	import PaginationNav from './paginations/PaginationNav.svelte';

	export let provider: EIP1193Provider | undefined;
	export let etherscanURL: string | undefined = undefined;

	let currentPage = 1;
	const pageSize = 12;
	$: items = paginate({items: $state.nfts, pageSize, currentPage});
</script>

{#if provider}
	<div class="container">
		<PaginationNav
			{currentPage}
			{pageSize}
			totalItems={$state.nfts.length}
			limit={1}
			showStepOptions={true}
			on:setPage={(e) => (currentPage = e.detail.page)}
		/>
		<h2 class="heading-text">Your <span>NFTs</span></h2>
		<ul class="image-gallery">
			{#each items as nft (nft.tokenAddress + '_' + nft.tokenID)}
				<LoadingNft {etherscanURL} {provider} tokenAddress={nft.tokenAddress} tokenID={nft.tokenID} />
			{/each}
		</ul>
		<PaginationNav
			{currentPage}
			{pageSize}
			totalItems={$state.nfts.length}
			limit={1}
			showStepOptions={true}
			on:setPage={(e) => (currentPage = e.detail.page)}
		/>
	</div>
{/if}

<style>
	/* ======================================
Responsive Image gallery Style rules
======================================*/

	.container {
		padding: 40px 5%;
	}

	.heading-text {
		margin-bottom: 2rem;
		font-size: 2rem;
		text-align: center;
	}

	.heading-text span {
		font-weight: 100;
	}

	ul {
		list-style: none;
	}

	/* Responsive image gallery rules begin*/

	.image-gallery {
		text-align: center;
	}

	.image-gallery {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 10px;
	}

	.image-gallery::after {
		content: '';
		flex-basis: 350px;
	}
</style>
