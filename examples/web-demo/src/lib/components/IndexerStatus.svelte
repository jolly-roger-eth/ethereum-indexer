<script lang="ts">
	import type {Abi, StatusState, SyncingState} from 'ethereum-indexer-browser';

	export let status: Readable<StatusState>;
	export let syncing: Readable<SyncingState<Abi>>;

	import type {Readable} from 'svelte/store';
</script>

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
<!-- <p>num events: {(($syncing.lastSync?.numEvents ? || 1) - 1).toLocaleString()}</p> -->
