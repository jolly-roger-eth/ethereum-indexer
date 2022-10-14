<script lang="ts">
	import {browserIndexer, state, numRequests} from '$lib/state/State';
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
	$: stateDisplayed = addLengthToFields($state);
</script>

<progress value={($browserIndexer?.syncPercentage || 0) / 100} style="width:100%;" />

<p>requests sent: {$numRequests}</p>
<p>block processed: {$browserIndexer?.numBlocksProcessedSoFar.toLocaleString()}</p>
<p>num events: {$browserIndexer?.nextStreamID.toLocaleString()}</p>

{#if $state}
	<JSONTree value={stateDisplayed} />
{:else if $browserIndexer}
	<JSONTree value={$browserIndexer} />
{/if}
