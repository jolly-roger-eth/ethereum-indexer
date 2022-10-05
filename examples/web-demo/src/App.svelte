<script lang="ts">
	import {browserIndexer, state, stringify} from '$lib/state/State';
</script>

<progress value={($browserIndexer?.syncPercentage || 0) / 100} style="width:100%;" />

<p>block processed: {$browserIndexer?.numBlocksProcessedSoFar.toLocaleString()}</p>
<p>num events: {$browserIndexer?.nextStreamID.toLocaleString()}</p>

<details>
	{$state ? stringify($state) : $browserIndexer ? stringify($browserIndexer) : 'Please wait...'}
</details>
