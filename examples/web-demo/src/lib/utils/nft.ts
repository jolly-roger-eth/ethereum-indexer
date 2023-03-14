import type {EIP1193Provider} from 'eip-1193';

export type NFTVisuals = [NFTImage, NFTIframe] | [NFTIframe] | [NFTImage];
export type NFTValue = {
	visuals?: NFTVisuals;
	audio?: NFTAudio;
	name?: string;
	description?: string;
};
export type NFTImage = {
	type: 'image';
	url: string;
	cssURL: string;
};
export type NFTIframe = {
	type: 'iframe';
	url: string;
};
export type NFTAudio = {
	type: 'audio';
	url: string;
};

function hex_to_ascii(hex: string) {
	var str = '';
	for (var n = 0; n < hex.length; n += 2) {
		str += String.fromCharCode(parseInt(hex.substring(n, n + 2), 16));
	}
	return str;
}

export async function fetchDisplayedObjects(
	provider: EIP1193Provider,
	tokenAddress: `0x${string}`,
	tokenID: bigint | string
): Promise<NFTValue> {
	return getTokenURI(provider, tokenAddress, tokenID).then((tokenURI) => fetchDisplayedObjectsFromTokenURI(tokenURI));
}

export async function getTokenURI(provider: EIP1193Provider, tokenAddress: `0x${string}`, tokenID: bigint | string) {
	let tokenIDAsHex = typeof tokenID === 'bigint' ? tokenID.toString(16) : BigInt(tokenID).toString(16);

	if (tokenAddress.toLowerCase() === '0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85') {
		throw new Error(`ENS names do not have metadata.`);
	}
	const tokenURIData = await provider.request({
		method: 'eth_call',
		params: [{to: tokenAddress, data: `0xc87b56dd${tokenIDAsHex.padStart(64, '0')}`}, 'latest'],
	});

	const hex = tokenURIData.slice(2);
	const hex2 = hex.slice(64);
	const len = hex2.slice(0, 64);
	const size = parseInt(len, 16);
	const hexData = hex2.slice(64, 64 + size * 2);
	const tokenURI = hex_to_ascii(hexData);

	// if (
	// 	tokenURI.startsWith('http') &&
	// 	!(
	// 		tokenURI.startsWith('https://ipfs.io/') ||
	// 		tokenURI.startsWith('https://dweb.link/') ||
	// 		tokenURI.startsWith('https://nftstorage.link/') ||
	// 		tokenURI.startsWith('https://arweave.dev/')
	// 	)
	// ) {
	// 	throw new Error(`no support for HTTP, only IPFS and Arweave supported`);
	// }
	return tokenURI;
}

function normalizeURL(url: string) {
	if (url.startsWith('ipfs://')) {
		return 'https://ipfs.io/ipfs/' + url.slice(7);
	} else if (url.startsWith('ar://')) {
		return 'https://arweave.dev/' + url.slice(5);
	} else {
		return url;
	}
}

const cssRegex = new RegExp('\\/', 'gm');
function makeImageURLCompatibleWithCSS(url: string) {
	if (url.startsWith('data:')) {
		return url.replace(cssRegex, '\\/');
	}
	return url;
}

export async function fetchTokenURI(tokenURI: string) {
	if (tokenURI === '') {
		return {};
	}
	let metadataResponse;
	try {
		metadataResponse = await fetch(tokenURI);
	} catch (err) {
		if (tokenURI.startsWith('http') && err.response === undefined) {
			throw new Error(
				`Could not fetch token's metadata. This could be a CORS issue or a dropped internet connection. It is not possible for us to know. (Please check in your browser console). If it is a CORS issue, please contact the persons responsible for the project and tell them to allow CORS. We are building a decentralised world after all.`,
				{cause: {type: 'CORS?'}}
			);
		} else {
			throw new Error(`Could not fetch token's metadata. ${err.message || err}`, {cause: {type: 'CORS?'}});
		}
	}
	return metadataResponse.json();
}

const audioExtensions = ['wav', 'mp3', 'ogg', 'flac']; // TODO more
// TODO video
const htmlExtensions = ['html', 'htm'];

function endsWith(str: string, ends: string[]) {
	for (const end of ends) {
		if (str.endsWith(end)) {
			return true;
		}
	}
	return false;
}

export async function fetchDisplayedObjectsFromTokenURI(tokenURI: string): Promise<NFTValue> {
	const metadataURLToFetch = normalizeURL(tokenURI);
	const metadata = await fetchTokenURI(metadataURLToFetch);

	let iframe: NFTIframe | undefined;
	let image: NFTImage | undefined;
	let audio: NFTAudio | undefined;

	let iframeURL: string | undefined;
	let audioURL: string | undefined;
	if (metadata.animation_url) {
		if (metadata.animation_url.startsWith('data:text/html') || endsWith(metadata.animation_url, htmlExtensions)) {
			iframeURL = normalizeURL(metadata.animation_url);
		} else if (metadata.animation_url.startsWith('data:audio/') || endsWith(metadata.animation_url, audioExtensions)) {
			audioURL = normalizeURL(metadata.animation_url);
		}
	}

	if (iframeURL) {
		iframe = {
			type: 'iframe',
			url: iframeURL,
		};
	}
	if (metadata.image) {
		const imageURL = normalizeURL(metadata.image);
		image = {
			type: 'image',
			url: imageURL,
			cssURL: makeImageURLCompatibleWithCSS(imageURL),
		};
	}
	if (audioURL) {
		audio = {
			type: 'audio',
			url: audioURL,
		};
	}

	const visuals = [];
	if (iframe) {
		visuals.push(iframe);
	}
	if (image) {
		visuals.push(image);
	}

	return {
		visuals: visuals.length > 0 ? (visuals as NFTVisuals) : undefined,
		audio,
		name: metadata.name,
		description: metadata.description,
	};
}
