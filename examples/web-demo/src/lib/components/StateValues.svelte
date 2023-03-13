<script lang="ts">
	export let state: Readable<any>;
	export let syncing: Readable<any>;

	import Json from './JSON.svelte';
	import type {Readable} from 'svelte/store';
</script>

{#if $state}
	<Json data={$state} />
{:else}
	<Json data={$syncing} />
{/if}
