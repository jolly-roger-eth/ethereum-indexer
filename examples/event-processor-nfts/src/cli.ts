import eip721 from './eip721.js';
import {NFTProcessor} from './entities.js';

/**
 * The same processor, run from a terminal instead of from a tab.
 *
 * `entities.ts` is UNCHANGED and is imported as-is: this file adds no handler,
 * no declaration and no backend, because there is nothing about the CLI for a
 * processor to know. It exists only to say two things a module has to say to a
 * host that loads it -- which KIND of processor this is, and what to index --
 * neither of which a browser page needs, since an app passes both at the call
 * site (`browser/main.ts`).
 *
 * ```sh
 * pnpm --filter event-processor-nfts build
 * NFT_CONTRACT=0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d NFT_START_BLOCK=21000000 \
 *   pnpm --filter event-processor-nfts index -n https://rpc.mevblocker.io
 * ```
 *
 * See the README for what that prints and what lands in the database.
 */

/**
 * The KIND, said by the module in the same two words `@etherfold/browser` takes.
 *
 * `{kind: 'entities', processor}` is the tag; a module that returns a bare
 * processor means `'js-object'`, which is why `index.ts` next door needs no tag
 * at all. What travels here is the AUTHORING object -- declarations plus
 * handlers -- because WHERE the state lives is the deployment's choice: the CLI
 * builds the store named by `--store` and wraps this in the runtime that writes
 * to it. A `--kind` flag would have been a second source of truth for one fact.
 */
export const createProcessor = () => ({kind: 'entities', processor: NFTProcessor}) as const;

/**
 * WHAT to index, per chain.
 *
 * Keyed by chain id because that is what a host can resolve for itself: the CLI
 * asks the node which chain it is on and picks the entry. One collection rather
 * than every address, because a terminal has no topic filter to narrow with (the
 * browser app filters `Transfer` on one account's topics, which is a stream
 * config an app passes and a flag cannot express) -- and "every ERC-721 transfer
 * on mainnet" is not a demo, it is a bill.
 *
 * Both values come from the environment so the command in the README points
 * wherever a reader wants. The default is Bored Ape Yacht Club, and the default
 * start block is deliberately recent rather than the deployment block: the first
 * sync is what a reader waits for.
 */
const address = (process.env.NFT_CONTRACT ?? '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d') as `0x${string}`;
const startBlock = Number(process.env.NFT_START_BLOCK ?? 21_000_000);

export const contractsDataPerChain = {'1': [{abi: eip721, address, startBlock}]};

/** Re-exported so a reader importing this module gets the same names the browser app uses. */
export {abi, NFTProcessor, readableTokenID} from './entities.js';
