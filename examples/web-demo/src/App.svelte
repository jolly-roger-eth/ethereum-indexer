<script lang="ts">
	import {browserIndexer, state, stringify} from '$lib/state/State';
</script>

{$browserIndexer?.syncPercentage}
<p>
	{$state ? stringify($state) : $browserIndexer ? stringify($browserIndexer) : 'Please wait...'}
</p>
