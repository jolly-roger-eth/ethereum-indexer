<script lang="ts">
	export let status: Readable<any>;
	export let state: Readable<any>;
	export let syncing: Readable<any>;
	export let chainId: string;
	export let requireAccounts: boolean;

	export let initialize: (connection: {ethereum: EIP1193Provider; accounts: `0x${string}`[]}) => void;

	import {web3} from '../blockchain/connection';
	import Json from '../components/JSON.svelte';
	import type {Readable} from 'svelte/store';
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
	<button on:click={() => web3.start(chainId, requireAccounts).then(initialize)}>Start</button>
{:else if $web3.state === 'Loading'}
	Loading...
{:else if $web3.state === 'SwithingChain'}
	Switching chain...
{/if}

<progress value={($syncing.lastSync?.syncPercentage || 0) / 100} style="width:100%;" />

<p>status: {$status.state}</p>
<p>loading: {$syncing.loading}</p>
<p>catchingUp: {$syncing.catchingUp}</p>
<p>autoIndexing: {$syncing.autoIndexing}</p>
<p>fetchingLogs: {$syncing.fetchingLogs}</p>
<p>processingFetchedLogs: {$syncing.processingFetchedLogs}</p>

{#if $syncing.numRequests !== undefined}
	<p>requests sent: {$syncing.numRequests}</p>
{/if}
<p>block processed: {$syncing.lastSync?.numBlocksProcessedSoFar?.toLocaleString() || 0}</p>
<p>num events: {(($syncing.lastSync?.nextStreamID || 1) - 1).toLocaleString()}</p>

{#if $state}
	<Json data={$state} />
{:else}
	<Json data={$syncing} />
{/if}
