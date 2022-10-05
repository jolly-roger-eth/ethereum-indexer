<script lang="ts">
	import {browserIndexer, state, stringify} from '$lib/state/State';
</script>

{$browserIndexer?.latestBlock}
{$browserIndexer?.lastToBlock}
{stringify($browserIndexer)}
<p>
	{$state ? stringify($state) : $browserIndexer ? stringify($browserIndexer) : 'Please wait...'}
</p>
