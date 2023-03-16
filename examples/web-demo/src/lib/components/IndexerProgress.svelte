<script lang="ts">
	import type {Abi, SyncingState} from 'ethereum-indexer-browser';
	export let syncing: Readable<SyncingState<Abi>>;
	import type {Readable} from 'svelte/store';
</script>

<progress value={($syncing.lastSync?.syncPercentage || 0) / 100} style="width:100%;" />
<progress value={($syncing.lastSync?.totalPercentage || 0) / 100} style="width:100%;" />
