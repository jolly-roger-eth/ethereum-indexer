<script lang="ts">
	export let state: Readable<any>;
	import type {EIP1193Provider} from 'eip-1193';
	import type {Readable} from 'svelte/store';
	import LoadingNft from './LoadingNFT.svelte';

	export let provider: EIP1193Provider | undefined;
</script>

{#if provider && $state}
	<div class="container">
		<h2 class="heading-text">Your <span>NFTs</span></h2>
		<ul class="image-gallery">
			{#each $state.nfts as nft (nft.id)}
				<LoadingNft {provider} tokenAddress={nft.tokenAddress} tokenID={nft.tokenID} />
			{/each}
		</ul>
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
