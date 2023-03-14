export async function hash(obj: unknown) {
	const encoder = new TextEncoder();
	const data = encoder.encode(typeof obj === 'string' ? obj : JSON.stringify(obj));
	const hashArrayBuffer = await crypto.subtle.digest('SHA-256', data);
	const hashArray = Array.from(new Uint8Array(hashArrayBuffer)); // convert buffer to byte array
	const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join(''); // convert bytes to hex string
	return hashHex;
}
