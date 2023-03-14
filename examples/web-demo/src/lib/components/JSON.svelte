<script lang="ts">
	// import JSONTree from 'svelte-json-tree';

	import {addLengthToFields} from '../utils/format';

	export let data: any;
	$: dataDisplayed = data ? addLengthToFields(data) : undefined;
</script>

{JSON.stringify(
	dataDisplayed,
	(_, value) => (typeof value === 'bigint' ? value.toString() : value) // return everything else unchanged)}
)}
