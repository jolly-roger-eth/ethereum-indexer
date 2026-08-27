import {defineConfig} from 'vitepress';
import typedocSidebar from '../api/typedoc-sidebar.json';
import {title,description, canonicalURL} from '../web-config.json'

function order(arr: any, startWith?: string) {
	return arr.sort((a, b) => {
		if (startWith) {
			if (a.text === startWith) {
				return -1;
			}
			if (b.text === startWith) {
				return 1;
			}
		}
		if (a < b) {
			return -1;
		}
		if (a > b) {
			return 1;
		}
		return 0;
	});
}

function removeDuplicates(arr: any) {
	const newArray: any[] = [];
	const dict = {};
	for (const elem of arr) {
		const id = elem.text;
		if (!dict[id]) {
			dict[id] = true;
			newArray.push(elem);
		}
	}

	return newArray;
}

const host = canonicalURL;
const preview = `${host}/preview.png`;

// https://vitepress.dev/reference/site-config
export default defineConfig({
	title,
	head: [
		['link', {rel: 'icon', href: '/pwa/favicon.svg', type: 'image/svg+xml'}],
		['link', {rel: 'icon', href: '/pwa/favicon.ico', sizes: 'any'}],
		['link', {rel: 'apple-touch-icon', href: '/pwa/apple-touch-icon.png'}],
		['link', {rel: 'manifest', href: '/pwa/manifest.webmanifest'}],
		['meta', {name: 'theme-color', content: '#00000'}],
		['meta', {name: 'mobile-web-app-capable', content: 'yes'}],
		['meta', {name: 'apple-mobile-web-app-capable', content: 'yes'}],
		['meta', {name: 'application-name', content: title}],
		['meta', {name: 'apple-mobile-web-app-status-bar-style', content: 'black-translucent'}],
		['meta', {name: 'apple-mobile-web-app-title', content: title}],
		['meta', {property: 'og:url', content: host}],
		['meta', {property: 'og:type', content: 'website'}],
		['meta', {property: 'og:title', content: title}],
		[
			'meta',
			{
				property: 'og:description',
				content: description,
			},
		],
		['meta', {property: 'og:image', content: preview}],
		['meta', {property: 'twitter:card', content: 'summary_large_image'}],
		['meta', {property: 'twitter:url', content: host}],
		['meta', {property: 'twitter:title', content: title}],
		[
			'meta',
			{
				property: 'twitter:description',
				content: description,
			},
		],
		['meta', {property: 'twitter:image', content: preview}],
	],
	description,
	// API pages are generated from the source: their titles are class, interface and
	// type names. Tag them so the theme can keep them in the default font instead of
	// the Audiowide display face (see .vitepress/theme/custom.css).
	transformPageData(pageData) {
		if (pageData.relativePath.startsWith('api/')) {
			pageData.frontmatter.pageClass = 'api-page';
		}
	},
	themeConfig: {
		// https://vitepress.dev/reference/default-theme-config
		logo: {dark: '/icon-white.svg', light: '/icon.svg', alt: 'ethereun-indexer'},
		
		nav: [
			{text: 'Home', link: '/'},
			{text: 'Getting Started', link: '/guide/getting-started/'},
			{text: 'Browser apps', link: '/guide/indexing-in-a-browser-app/'},
			{text: 'API', link: '/api/'},
		],

		siteTitle: ' ',

		sidebar: [
			{
				text: 'Guide',
				items: [
					{text: 'Getting Started', link: '/guide/getting-started/'},
					{text: 'Indexing in a browser app', link: '/guide/indexing-in-a-browser-app/'},
				],
			},
			{
				text: 'API',
				link: '/api/',
				items: order(removeDuplicates(typedocSidebar), 'createExecutor'),
			},
		],

		socialLinks: [{icon: 'github', link: 'https://github.com/wighawag/etherfold/#readme'}],

		search: {
			provider: 'local',
		},
	},
	// The GitHub Pages project path, which is the REPO name and not the package
	// name: the site is served from `wighawag.github.io/etherfold/`. Pages is not
	// redirected across a repository move (git and web URLs are), so this had to
	// move with the repo. Drop it to `/` only once `etherfold.dev` is a real custom
	// domain, which `docs/web-config.json` already claims as the canonical URL.
	base: '/etherfold'
});
