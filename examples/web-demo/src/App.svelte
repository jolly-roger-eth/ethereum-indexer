<script lang="ts">
	import Conquest from './pages/Conquest.svelte';
	import Home from './pages/Home.svelte';
	import MyNfts from './pages/MyNFTS.svelte';
	import Bleeps from './pages/Bleeps.svelte';

	function getPage() {
		const page = document.location.hash;
		if (page === '' || page === '#') {
			console.log(`HOME`);
			document.location.assign(document.location.toString().split('#')[0] + '#home');
		}
		return page;
	}
	let page = getPage();
	window.onpopstate = function () {
		page = getPage();
	};
</script>

<nav class="container-fluid" style="margin-bottom: 1em;">
	<ul>
		<li><a href="#home">Home</a></li>
		<li><a href="#conquest">Conquest</a></li>
		<li><a href="#bleeps">Bleeps</a></li>
		<li><a href="#mynfts">My NFTS</a></li>
	</ul>
</nav>
{#if page === '#' || page === '' || page === '#home'}
	<Home />
{:else if page === '#conquest'}
	<Conquest />
{:else if page === '#bleeps'}
	<Bleeps />
{:else if page === '#mynfts'}
	<MyNfts />
{:else}
	404: Page not Found
{/if}
