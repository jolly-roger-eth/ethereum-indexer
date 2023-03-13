<script lang="ts">
	export let chainId: string;
	export let accountsToUse: boolean | `0x${string}`;

	export let initialize: (connection: {ethereum: EIP1193Provider; accounts: `0x${string}`[]}) => void;

	import {web3} from '../blockchain/connection';
	import {onMount} from 'svelte';
	import type {EIP1193Provider} from 'eip-1193';

	onMount(() => {
		web3.reset();
	});
</script>

{#if $web3.error}
	<h1>{$web3.error}</h1>
{/if}
{#if $web3.state === 'Idle'}
	<button on:click={() => web3.start(chainId, accountsToUse).then(initialize)}>Start</button>
{:else if $web3.state === 'Loading'}
	Loading...
{:else if $web3.state === 'SwithingChain'}
	Switching chain...
{/if}
