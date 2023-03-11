<script lang="ts">
	import {status, state, syncing, indexer} from './lib/state/State';
	import JSONTree from 'svelte-json-tree';

	function addLengthToFields(v: any): any {
		const keys = Object.keys(v);
		const n = {};
		for (const key of keys) {
			if (typeof v[key] === 'object') {
				n[key + ` (${Object.keys(v[key]).length})`] = v[key];
			} else {
				n[key] = v[key];
			}
		}
		return n;
	}
	$: stateDisplayed = $state ? addLengthToFields($state) : undefined;
</script>

{#if $indexer.state === 'Idle'}
	<button on:click={() => indexer.start()}>Start</button>
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
	{JSON.stringify(
		stateDisplayed,
		(key, value) => (typeof value === 'bigint' ? value.toString() : value) // return everything else unchanged
	)}
{:else}
	{JSON.stringify($syncing)}
{/if}
