<script lang="ts" generics="ABI extends Abi">
	export let state: Readable<any>;
	export let syncing: Readable<SyncingState<ABI>>;

	import Json from './JSON.svelte';
	import type {Readable} from 'svelte/store';
	import type {SyncingState} from '@etherfold/browser';
	import type {Abi} from '@etherfold/core';
</script>

{#if $state}
	<Json data={$state} />
{:else}
	<Json data={$syncing} />
{/if}
