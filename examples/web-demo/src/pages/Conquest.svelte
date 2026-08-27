<script lang="ts">
	import {createProcessor, contractsDataPerChain} from 'event-processor-conquest-eth';
	import {createIndexeInitializer} from '../lib/blockchain/indexer';
	import IndexerButton from '../lib/components/IndexerButton.svelte';
	import IndexerProgress from '../lib/components/IndexerProgress.svelte';
	import IndexerStatus from '../lib/components/IndexerStatus.svelte';
	import StateValues from '../lib/components/StateValues.svelte';
	const chainId = '100';

	const processor = createProcessor();
	const {status, state, syncing, initialize} = createIndexeInitializer(
		'conquest',
		processor,
		// The published contract data widens its ABI to `{name: string; type: string; ...}[]`,
		// while the generic is inferred from the sibling contract's `as const` ABI, so the
		// two disagree on a tuple of 70 elements. A demo-side cast; the runtime shape is right.
		contractsDataPerChain[chainId] as never,
		chainId,
	);
</script>

<IndexerButton {initialize} {chainId} accountsToUse={false} />
<IndexerProgress {syncing} />
<IndexerStatus {status} {syncing} />
<StateValues {state} {syncing} />
