<script lang="ts">
	export let chainId: string | undefined = undefined;
	export let accountsToUse: boolean | `0x${string}`;

	export let initialize: (connection: ActiveConnection) => void;

	import {web3, type ActiveConnection} from '../blockchain/connection';
	import {onMount} from 'svelte';

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
