/**
 * Verify the browser example end to end, in a real browser, on a real chain.
 *
 * `pnpm --filter event-processor-nfts verify:browser`
 *
 * ## Why this checks the HARNESS before it judges the app
 *
 * This file exists because of a debugging session that blamed a dependency for
 * two days' worth of nothing. The symptom was: `import()` never resolved, never
 * rejected, the console was empty, and `document.readyState` stayed at
 * `interactive` forever. That was read as "the library hangs during module
 * evaluation". It was not. The static server serving the bundle answered the
 * request headers and then never delivered the body, so the module never
 * arrived, and a module that never arrives produces EXACTLY those symptoms --
 * silence being the tell, since code that throws, loops or fails to resolve all
 * leave a trace and code that never ran leaves none.
 *
 * `curl` fetched the same file happily, which is what made the false conclusion
 * stick: a client that does not behave like a browser is not evidence about a
 * browser. So the health check below is not decoration and it runs FIRST:
 *
 * - every request must FINISH, not merely return a status;
 * - `content-length`, where sent, must equal the bytes actually received;
 * - the page URL comes from what the server PRINTED, never from an assumption
 *   (the same session lost another hour to `vite preview` binding `[::1]` while
 *   the tests asked for `127.0.0.1`, which is a black hole rather than a refusal).
 *
 * If the harness is unhealthy the run fails as a HARNESS failure with that word
 * in the message, so the next person does not go looking in the application.
 */
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {chromium} from '@playwright/test';
import {walletStub, METAMASK, RABBY} from './wallet-stub.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLE = resolve(HERE, '..');
const RPC = process.env.RPC_URL ?? 'https://rpc.mevblocker.io';
const VITALIK = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

let failures = 0;
const check = (ok, what, detail = '') => {
	console.log(`    ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? `  ${detail}` : ''}`);
	if (!ok) failures++;
};

/** Start `vite preview` and take the URL from what it prints. */
async function startServer() {
	const proc = spawn('pnpm', ['exec', 'vite', 'preview', '--port', '0'], {
		cwd: EXAMPLE,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	const url = await new Promise((res, rej) => {
		const timer = setTimeout(() => rej(new Error('HARNESS: vite preview printed no URL within 30s')), 30000);
		let buffer = '';
		const onData = (chunk) => {
			buffer += chunk.toString();
			const match = buffer.match(/https?:\/\/[^\s]*localhost:\d+\/?/);
			if (match) {
				clearTimeout(timer);
				res(match[0].replace(/\/$/, ''));
			}
		};
		proc.stdout.on('data', onData);
		proc.stderr.on('data', onData);
		proc.on('exit', (code) => rej(new Error(`HARNESS: vite preview exited early (${code})`)));
	});
	return {proc, url};
}

/**
 * Load a page, watch every request, and report both the DOM and the harness's
 * own health.
 */
async function load(browser, url, {init, waitMs = 45000} = {}) {
	const page = await browser.newPage();
	const requests = new Map();
	page.on('request', (r) => requests.set(r.url(), {finished: false, status: null, bytes: null}));
	page.on('response', (r) => {
		const e = requests.get(r.url());
		if (e) {
			e.status = r.status();
			e.headers = r.headers();
		}
	});
	page.on('requestfinished', async (r) => {
		const e = requests.get(r.url());
		if (!e) return;
		e.finished = true;
		try {
			e.bytes = (await r.response().then((x) => x.body())).length;
		} catch {
			e.bytes = 'ERR';
		}
	});
	page.on('requestfailed', (r) => {
		const e = requests.get(r.url());
		if (e) e.failed = r.failure()?.errorText;
	});
	const errors = [];
	page.on('pageerror', (e) => errors.push(e.message));

	if (init) await page.addInitScript(init);
	await page.goto(url, {waitUntil: 'commit', timeout: 30000});
	await page.waitForTimeout(waitMs);

	const text = async (id) =>
		(
			await page
				.locator(`#${id}`)
				.innerText()
				.catch(() => '')
		)
			.replace(/\s+/g, ' ')
			.trim();
	const dom = Object.fromEntries(
		await Promise.all(
			['what', 'via', 'where', 'progress', 'transfers', 'undecodable', 'resume', 'tokens', 'error', 'picker'].map(
				async (id) => [id, await text(id)],
			),
		),
	);
	const ready = await page.evaluate(() => document.readyState).catch(() => 'UNRESPONSIVE');
	const walletCalls = await page.evaluate(() => window.__walletCalls ?? 0).catch(() => 0);

	// ---- the harness's own health, judged before the app is ----
	// Scoped to what THIS harness serves. A request to the chain endpoint that is
	// still in flight when the snapshot is taken is normal -- the page keeps
	// polling for new blocks forever, so an in-flight RPC call is the app working
	// rather than a stalled body. The fault this check exists to catch is a served
	// ASSET whose body never arrives, and that is always same-origin.
	const ours = (u) => u.startsWith(new URL(url).origin);
	const unfinished = [...requests.entries()].filter(([u, e]) => ours(u) && !e.finished && !e.failed);
	const mismatched = [...requests.entries()].filter(
		([u, e]) =>
			ours(u) && e.finished && e.headers?.['content-length'] && Number(e.headers['content-length']) !== e.bytes,
	);
	const healthy = unfinished.length === 0 && mismatched.length === 0 && ready !== 'UNRESPONSIVE';
	if (!healthy) {
		console.log('    HARNESS UNHEALTHY -- do not blame the application:');
		for (const [u, e] of unfinished) console.log(`      request never finished: ${u}  (status=${e.status})`);
		for (const [u, e] of mismatched)
			console.log(`      content-length ${e.headers['content-length']} != ${e.bytes} bytes: ${u}`);
		if (ready === 'UNRESPONSIVE') console.log('      page.evaluate() did not answer: the main thread is blocked');
	}

	return {page, dom, ready, walletCalls, errors, healthy};
}

async function main() {
	const {proc, url} = await startServer();
	const browser = await chromium.launch();
	const stub = (opts) => walletStub({rpc: RPC, ...opts});

	try {
		// ------------------------------------------------------------------
		console.log('\n  1. no wallet, ?account= given, reading through the endpoint');
		{
			const r = await load(browser, `${url}/?account=${VITALIK}&via=endpoint&blocks=40000`, {waitMs: 60000});
			check(r.healthy, 'harness healthy');
			check(r.ready === 'complete', 'document reached readyState=complete', `(${r.ready})`);
			check(r.errors.length === 0, 'no page errors', r.errors[0] ?? '');
			check(/100%/.test(r.dom.progress), 'indexed to the tip', r.dom.progress);
			check(r.dom.via.includes('?via=endpoint'), 'reports the endpoint as its source', r.dom.via);
			check(/refused/.test(r.dom.undecodable), 'counted the ERC-20 collisions', r.dom.undecodable.slice(0, 60));
			check(r.dom.error === '', 'no error shown', r.dom.error);
			await r.page.close();
		}

		// ------------------------------------------------------------------
		console.log('\n  2. ONE wallet, ?account= given: WalletChosen, no connect prompt');
		{
			const r = await load(browser, `${url}/?account=${VITALIK}&blocks=2000`, {
				init: stub({wallets: [METAMASK], accounts: []}),
				waitMs: 40000,
			});
			check(r.healthy, 'harness healthy');
			check(r.ready === 'complete', 'document reached readyState=complete', `(${r.ready})`);
			check(r.walletCalls > 0, 'reads ROUTED THROUGH the wallet', `${r.walletCalls} calls`);
			check(/MetaMask/.test(r.dom.via), 'names the chosen wallet', r.dom.via);
			check(/chosen, not connected/.test(r.dom.via), 'says chosen rather than connected', r.dom.via);
			check(r.dom.error === '', 'no error shown', r.dom.error);
			await r.page.close();
		}

		// ------------------------------------------------------------------
		console.log('\n  3. TWO wallets: the picker appears, and choosing one proceeds');
		{
			const r = await load(browser, `${url}/?account=${VITALIK}&blocks=2000`, {
				init: stub({wallets: [METAMASK, RABBY], accounts: []}),
				waitMs: 8000,
			});
			check(r.healthy, 'harness healthy');
			check(
				/Which should read the chain/.test(r.dom.picker),
				'picker shown for two wallets',
				r.dom.picker.slice(0, 60),
			);
			const buttons = await r.page.locator('#picker button').allInnerTexts();
			check(buttons.length === 2, 'one button per wallet', buttons.join(', '));
			await r.page.locator('#picker button', {hasText: 'Rabby'}).click();
			await r.page.waitForTimeout(30000);
			const via = (await r.page.locator('#via').innerText()).replace(/\s+/g, ' ');
			check(/Rabby/.test(via), 'proceeds with the wallet that was clicked', via);
			await r.page.close();
		}

		// ------------------------------------------------------------------
		console.log('\n  4. ONE wallet, NO ?account=: WalletConnected, uses the wallet account');
		{
			const account = '0x1111111111111111111111111111111111111111';
			const r = await load(browser, `${url}/?blocks=2000`, {
				init: stub({wallets: [METAMASK], accounts: [account]}),
				waitMs: 40000,
			});
			check(r.healthy, 'harness healthy');
			check(r.dom.what.toLowerCase().includes(account), 'indexes the CONNECTED account', r.dom.what);
			check(/connected/.test(r.dom.via) && !/chosen, not connected/.test(r.dom.via), 'reports connected', r.dom.via);
			check(r.dom.error === '', 'no error shown', r.dom.error);
			await r.page.close();
		}

		// ------------------------------------------------------------------
		console.log('\n  5. wallet on the WRONG CHAIN: refused loudly, nothing indexed');
		{
			const r = await load(browser, `${url}/?account=${VITALIK}&blocks=2000`, {
				init: stub({wallets: [METAMASK], accounts: [], chainId: '0x89'}),
				waitMs: 15000,
			});
			check(r.healthy, 'harness healthy');
			check(/chain 137/.test(r.dom.error), 'names the wrong chain it found', r.dom.error.slice(0, 90));
			check(/via=endpoint/.test(r.dom.error), 'tells the reader how to proceed', '');
			check(r.dom.progress === '' || !/100%/.test(r.dom.progress), 'did NOT index anything', r.dom.progress);
			await r.page.close();
		}

		// ------------------------------------------------------------------
		console.log('\n  6. NO wallet and NO ?account=: explains itself instead of hanging');
		{
			const r = await load(browser, `${url}/?blocks=2000`, {waitMs: 15000});
			check(r.healthy, 'harness healthy');
			check(r.ready === 'complete', 'document reached readyState=complete', `(${r.ready})`);
			check(/no wallet announced itself/.test(r.dom.error), 'says no wallet was found', r.dom.error.slice(0, 80));
			check(/\?account=/.test(r.dom.error), 'offers the account escape hatch', '');
			await r.page.close();
		}
	} finally {
		await browser.close();
		proc.kill('SIGTERM');
	}

	console.log(failures === 0 ? '\n  ALL CHECKS PASSED\n' : `\n  ${failures} CHECK(S) FAILED\n`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
	console.error(`\n  ${String(error.message).startsWith('HARNESS') ? '' : 'unexpected: '}${error.message}`);
	process.exit(1);
});
