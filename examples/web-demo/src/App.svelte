<script lang="ts">
	import {status, state, syncing, initialize} from './lib/state/State';
	import {web3} from './lib/blockchain/connection';
	import Json from './lib/components/JSON.svelte';
</script>

{#if $web3.error}
	<h1>{$web3.error}</h1>
{/if}
{#if $web3.state === 'Idle'}
	<button on:click={() => web3.start().then(initialize)}>Start</button>
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
