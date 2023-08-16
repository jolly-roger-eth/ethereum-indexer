import {defineConfig} from 'vitepress';
import typedocSidebar from '../api/typedoc-sidebar.json';

// https://vitepress.dev/reference/site-config
export default defineConfig({
	title: 'ethereum-indexer',
	description: 'A modular indexer system for ethereum and other blockchain following the same RPC standard. ',
	themeConfig: {
		// https://vitepress.dev/reference/default-theme-config
		nav: [
			{text: 'Home', link: '/'},
			{text: 'Examples', link: '/markdown-examples'},
			{text: 'API', link: '/api/'},
		],

		sidebar: [
			{
				text: 'Examples',
				items: [
					{text: 'Markdown Examples', link: '/markdown-examples'},
					{text: 'Runtime API Examples', link: '/api-examples'},
				],
			},
			{
				text: 'API',
				link: '/api/',
				items: typedocSidebar,
			},
		],

		socialLinks: [{icon: 'github', link: 'https://github.com/vuejs/vitepress'}],
	},
});
