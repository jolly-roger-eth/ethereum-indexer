<script lang="ts">
	export let state: Readable<any>;
	export let syncing: Readable<SyncingState<Abi>>;

	import Json from './JSON.svelte';
	import type {Readable} from 'svelte/store';
	import type {Abi, SyncingState} from 'ethereum-indexer-browser';
</script>

{#if $state}
	<Json data={$state} />
{:else}
	<Json data={$syncing} />
{/if}
