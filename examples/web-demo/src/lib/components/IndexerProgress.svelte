<script lang="ts">
	export let syncing: Readable<any>;
	import type {Readable} from 'svelte/store';
</script>

<progress value={($syncing.lastSync?.syncPercentage || 0) / 100} style="width:100%;" />
