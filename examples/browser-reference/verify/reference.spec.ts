import {expect, test, type Page} from '@playwright/test';
import {installFakeWallet, type FakeChainOptions} from './wallet.js';

/**
 * The reference, DRIVEN in a real browser.
 *
 * This exists because of what it caught the last time: two bugs in this
 * repository's other browser example were written, reviewed, and BUILT GREEN,
 * and were found only by driving a real Chromium. Type-checking would have
 * caught neither (ADR-0030). So every claim `browser/main.ts` makes in a comment
 * is asserted here against the running page, and the two that are hazards get
 * the hostile version of the test rather than the happy one.
 *
 * Nothing here needs a network: the wallet announces itself over EIP-6963 and
 * serves a fixed set of logs, both injected before the app loads.
 */

const APP_CHAIN = 1;

async function open(page: Page, options: Partial<FakeChainOptions> = {}) {
	const settings: FakeChainOptions = {walletChainId: APP_CHAIN, transfers: 5, tipBlock: 10, ...options};
	await page.addInitScript(installFakeWallet, settings);
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(String(error)));
	await page.goto('/');
	return {errors, settings};
}

test('indexes the contract and publishes the result as stores', async ({page}) => {
	const {errors} = await open(page);

	await expect(page.locator('#transfers')).toHaveText('5');
	await expect(page.locator('#progress')).toContainText('block 10 / 10');
	await expect(page.locator('#error')).toBeEmpty();
	expect(errors).toEqual([]);
});

/**
 * HAZARD 1, the hostile version: the ALREADY-SETTLED path.
 *
 * A single announced wallet is auto-selected, so the connection has settled
 * before `waitForWallet` subscribes and the callback runs SYNCHRONOUSLY inside
 * `subscribe()`. Writing `const unsubscribe = connection.subscribe(...)` and
 * calling `unsubscribe` from the callback throws a temporal dead zone error on
 * exactly this path -- and only on this path, which is why a human clicking
 * through a picker never sees it.
 *
 * The assertion that matters is `errors`: an uncaught TDZ throw inside the
 * subscription surfaces as a `pageerror` while the page still looks half-alive.
 */
test('survives the already-settled wallet path, which is where the TDZ bug lived', async ({page}) => {
	const {errors} = await open(page);

	await expect(page.locator('#transfers')).toHaveText('5');
	expect(errors.filter((e) => e.includes('before initialization'))).toEqual([]);
	expect(errors).toEqual([]);
});

/**
 * HAZARD 2, the hostile version: a wallet on the WRONG chain.
 *
 * The pinned `connection.provider` answers `eth_chainId` with the app's own
 * chain whatever the wallet is set to, so an app that checks the provider passes
 * this and indexes a chain-1 address against a chain-137 node. An app that asks
 * the CONNECTION STATE refuses.
 *
 * This test is the difference between the two, and it is the one that would have
 * failed on the code that shipped.
 */
test('refuses a wallet on another chain, which the pinned provider cannot detect', async ({page}) => {
	await open(page, {walletChainId: 137});

	await expect(page.locator('#error')).toContainText('wallet is on chain 137');
	// and it refused rather than indexing the wrong chain quietly
	await expect(page.locator('#transfers')).toHaveText('0');
});

/**
 * AXIS TWO: a redeploy at the SAME address with a regenerated ABI.
 *
 * Driven through the app's own `onRedeploy`, so what runs is the wiring a
 * template would copy, not a re-implementation of it in the test.
 */
test('a new ABI at the same address discards the state and re-indexes', async ({page}) => {
	const {errors} = await open(page);
	await expect(page.locator('#transfers')).toHaveText('5');

	const discarded = await page.evaluate(async () => {
		const app = (window as never as {__reference: {onRedeploy(next: unknown): Promise<void>}}).__reference;
		// the ABI a redeployed implementation generates: same address, one more event
		const abiV2 = [
			{
				type: 'event',
				name: 'Transfer',
				anonymous: false,
				inputs: [
					{indexed: true, name: 'from', type: 'address'},
					{indexed: true, name: 'to', type: 'address'},
					{indexed: false, name: 'id', type: 'uint256'},
				],
			},
			{
				type: 'event',
				name: 'Approval',
				anonymous: false,
				inputs: [
					{indexed: true, name: 'owner', type: 'address'},
					{indexed: true, name: 'approved', type: 'address'},
					{indexed: true, name: 'id', type: 'uint256'},
				],
			},
		];
		await app.onRedeploy({abi: abiV2, address: '0x0000000000000000000000000000000000000099', startBlock: 0});
		return document.getElementById('reload')?.textContent ?? '';
	});

	expect(discarded).toContain('state discarded');
	// and it comes back, from the start block, under the new source
	await expect(page.locator('#transfers')).toHaveText('5');
	expect(errors).toEqual([]);
});

/**
 * THE FINALITY PAIRING: `checkTxInclusion`, and the direction that is safe.
 *
 * The transaction is one the fake chain really emitted, in a block inside the
 * unconfirmed window, so the verdict is a `window-hit` -- the only basis that
 * does not depend on any chain view but the indexer's own.
 */
test('says whether the indexed state already accounts for a transaction', async ({page}) => {
	await open(page);
	await expect(page.locator('#transfers')).toHaveText('5');

	const verdicts = await page.evaluate(() => {
		const app = (
			window as never as {
				__reference: {
					indexer: {checkTxInclusion(q: {txHash: string}[]): Record<string, {status: string; basis: string}>};
				};
			}
		).__reference;
		return app.indexer.checkTxInclusion([
			// block 5, which the fake chain emitted and the indexer has processed
			{txHash: `0x${(5).toString(16).padStart(64, '0')}`},
			// a transaction that emitted nothing this indexer watches
			{txHash: `0x${'ff'.repeat(32)}`},
		]);
	});

	const included = verdicts[`0x${(5).toString(16).padStart(64, '0')}`];
	expect(included.status).toBe('included');
	expect(included.basis).toBe('window-hit');

	// The documented limit, asserted rather than described: a transaction that
	// emitted no indexed event can never hit, so `absent` here means "not in the
	// window" and NOT "did not happen".
	expect(verdicts[`0x${'ff'.repeat(32)}`].status).toBe('absent');
});
