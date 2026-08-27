<script lang="ts" generics="ABI extends Abi">
	import type {SyncingState} from '@etherfold/browser';
	import type {Abi} from '@etherfold/core';
	export let syncing: Readable<SyncingState<ABI>>;
	import type {Readable} from 'svelte/store';
</script>

<progress value={($syncing.lastSync?.syncPercentage || 0) / 100} style="width:100%;"></progress>
<!-- <progress value={($syncing.lastSync?.totalPercentage || 0) / 100} style="width:100%;"></progress> -->
