/**
 * The URL helpers `src/config.ts` imports.
 *
 * This module was referenced from the day the example landed (`b98df28`) and
 * never existed. Nothing noticed for the same reason the rest of this change
 * exists: no gate reached `examples/`, and the one thing that did -- `vite
 * build` -- only ever resolves what it actually bundles. `config.ts` is
 * imported by nothing, so the bundler never followed the broken import and this
 * example built green with a module missing from it, for two years.
 *
 * Restored from the sibling `web-demo` example, which is where they came from,
 * rather than deleting the orphaned `config.ts`: deleting is the maintainer's
 * call, and is recorded in
 * `work/notes/observations/mud-example-config-is-orphaned.md`.
 */

export function getParamsFromURL(url: string): {
	params: Record<string, string>;
	pathname?: string;
} {
	if (!url) {
		return {params: {}, pathname: ''};
	}
	const obj: Record<string, string> = {};
	const hash = url.lastIndexOf('#');

	let cleanedUrl = url;
	if (hash !== -1) {
		cleanedUrl = cleanedUrl.slice(0, hash);
	}

	const question = cleanedUrl.indexOf('?');
	if (question !== -1) {
		cleanedUrl
			.slice(question + 1)
			.split('&')
			.forEach((piece) => {
				const [key, val = ''] = piece.split('=');
				obj[decodeURIComponent(key)] = val === '' ? 'true' : decodeURIComponent(val);
			});
	}

	let pathname = cleanedUrl.slice(0, question) || '';
	if (pathname && !pathname.endsWith('/')) {
		pathname += '/';
	}
	return {params: obj, pathname};
}

export function getParamsFromLocation(): {params: Record<string, string>; pathname?: string} {
	if (typeof window === 'undefined') {
		return {params: {}};
	}
	return getParamsFromURL(window.location.href);
}

export function getHashParamsFromLocation(str?: string): Record<string, string> {
	if (typeof window === 'undefined') {
		return {};
	}
	const url = str || window.location.hash;
	const obj: Record<string, string> = {};
	const hash = url.lastIndexOf('#');

	if (hash !== -1) {
		url
			.slice(hash + 1)
			.split('&')
			.forEach((piece) => {
				const [key, val = ''] = piece.split('=');
				obj[decodeURIComponent(key)] = decodeURIComponent(val);
			});
	}
	return obj;
}
