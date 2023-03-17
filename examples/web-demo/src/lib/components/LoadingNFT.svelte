<script lang="ts">
	import type {EIP1193Provider} from 'eip-1193';
	import {fetchDisplayedObjects} from '../utils/nft';
	import Nft from './NFT.svelte';

	export let provider: EIP1193Provider;
	export let etherscanURL: string | undefined = undefined;
	export let tokenID: string | bigint;
	export let tokenAddress: `0x${string}`;

	$: tokenIDAsString = typeof tokenID === 'bigint' ? tokenID.toString() : BigInt(tokenID).toString();

	$: objects = fetchDisplayedObjects(provider, tokenAddress, tokenID);
</script>

{#await objects}
	<li><div style="height: 350px;"><span>Please Wait</span></div></li>
{:then result}
	<Nft value={result} {tokenAddress} {tokenID} {etherscanURL} />
{:catch error}
	<li>
		<div style="height: 350px;">
			<span style="color: red;"
				>{error.data?.message || error.message || error.toString()}
				{#if etherscanURL}<a
						style="text-decoration: underline; color: blue;"
						href={`${etherscanURL}/nft/${tokenAddress}/${tokenIDAsString}`}
						target="_blank"
						rel="noreferrer">See on Etherscan</a
					>
				{/if}
			</span>
		</div>
	</li>
{/await}

<style>
	li {
		/* fallback */
		display: inline-block;
		width: 350px;
		margin: 0 5px 10px 5px;
		/* end fallback */
		position: relative;
		cursor: pointer;
	}
	li {
		flex-basis: 350px; /*width: 350px;*/
		margin: 0;
	}
</style>
