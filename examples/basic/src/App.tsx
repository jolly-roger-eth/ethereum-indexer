import './App.css';
import {fromJSProcessor, JSProcessor} from 'ethereum-indexer-js-processor';
import {createIndexerState} from 'ethereum-indexer-browser';
import {connect} from './utils/web3';
import react from 'react';

// we need the contract info
// the abi will be used by the processor to have its type generated, allowing you to get type-safety
// the adress will be given to the indexer, so it index only this contract
// the startBlock field allow to tell the indexer to start indexing from that point only
// here it is the block at which the contract was deployed
const contract = {
	abi: [
		{
			anonymous: false,
			inputs: [
				{
					indexed: true,
					name: 'user',
					type: 'address',
				},
				{
					indexed: false,
					name: 'message',
					type: 'string',
				},
			],
			name: 'MessageChanged',
			type: 'event',
		},
	],
	address: '0x21d366ee3BbF67AB057c517380D37E54fFd9dfC0',
	startBlock: 3040661,
} as const;

// we define the type of the state computed by the processor
// we can also declare it inline in the generic type of JSProcessor
type State = {greetings: {account: `0x${string}`; message: string}[]};

// the processor is given the type of the ABI as Generic type to get generated
// it also specify the type which represent the current state
const processor: JSProcessor<typeof contract.abi, State> = {
	construct() {
		return {greetings: []};
	},
	// each event has an associated on<EventName> function which is given both the current state and the typed event
	// each event's argument can be accessed via the `args` field
	// it then modify the state as it wishes
	onMessageChanged(state, event) {
		const greetingFound = state.greetings.find((v) => v.account === event.args.user);
		if (greetingFound) {
			greetingFound.message = event.args.message;
		} else {
			state.greetings.push({
				message: event.args.message,
				account: event.args.user,
			});
		}
	},
};

// we setup the indexer via a call to `createIndexerState`
// this setup a set of observable (subscribe pattern)
// including one for the current state (computed by the processor above)
// and one for the syncing status
const {init, useState, useSyncing, startAutoIndexing} = createIndexerState(fromJSProcessor(processor)()).withHooks(
	react
);

// we now need to get a handle on a ethereum provider
// for this app we are simply using window.ethereum
const ethereum = (window as any).ethereum;

// but to not trigger a metamask popup right away we wrap that in a function to be called via a click of a button
function start() {
	if (ethereum) {
		// here we first connect it to the chain of our choice and then initialise the indexer
		connect(ethereum, {
			chain: {
				chainId: '11155111',
				chainName: 'Sepolia',
				rpcUrls: ['https://rpc.sepolia.org'],
				nativeCurrency: {name: 'Sepolia Ether', symbol: 'SEP', decimals: 18},
				blockExplorerUrls: ['https://sepolia.etherscan.io'],
			},
		}).then(({ethereum}) => {
			// we already setup the processor
			// now we need to initialise the indexer with
			// - an EIP-1193 provider (window.ethereum here)
			// - source config which includes the chainId and the list of contracts (abi,address. startBlock)
			// here we also configure so the indexer uses ABI as global so events defined across contracts will be processed
			init({
				provider: ethereum,
				source: {chainId: '11155111', contracts: [contract]},
				// config: {stream: {parse: {globalABI: true}}},
			}).then(() => {
				// this automatically index on a timer
				// alternatively you can call `indexMore` or `indexMoreAndCatchupIfNeeded`, both available from the return value of `createIndexerState`
				// startAutoIndexing is easier but manually calling `indexMore` or `indexMoreAndCatchupIfNeeded` is better
				// this is because you can call them for every `newHeads` eth_subscribe message
				startAutoIndexing();
			});
		});
	}
}

function App() {
	// we use the hooks to get the latest state and make sure react update the values as they changes
	const $state = useState();
	const $syncing = useSyncing();

	if (!ethereum) {
		return (
			<div className="App">
				<h1>Indexing a basic example</h1>
				<p>To test this app, you need to have a ethereum wallet installed</p>
			</div>
		);
	}
	if ($syncing.waitingForProvider) {
		return (
			<div className="App">
				<h1>Indexing a basic example</h1>
				<button onClick={start} style={{backgroundColor: '#45ffbb', color: 'black'}}>
					Start
				</button>
			</div>
		);
	}

	return (
		<div className="App">
			<h1>Indexing a basic example</h1>
			<p>{$syncing.lastSync?.syncPercentage || 0}</p>
			{$syncing.lastSync ? (
				<progress value={($syncing.lastSync.syncPercentage || 0) / 100} style={{width: '100%'}} />
			) : (
				<p>Please wait...</p>
			)}
			<div>
				{$state.greetings.map((greeting) => (
					<p key={greeting.account}>{greeting.message}</p>
				))}
			</div>
		</div>
	);
}

export default App;
