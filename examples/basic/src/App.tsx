import './App.css';
import {fromJSProcessor, JSProcessor} from 'ethereum-indexer-js-processor';
import {createIndexerState} from 'ethereum-indexer-browser';
import {useReadable} from './utils/stores';
import {connect} from './utils/web3';

// we need the contract info
// the abi will be used by the processor to have its type generated, allowing you to get type-safety
// the adress will be given to the indexer, so it index only this contract
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
	address: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
} as const;

// the processor is given the type of the ABI as Generic type to get generated
// it also specify the type which represent the current state
const processor: JSProcessor<typeof contract.abi, {greetings: {account: `0x${string}`; message: string}[]}> = {
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
const {init, state, syncing, indexMoreAndCatchupIfNeeded} = createIndexerState(fromJSProcessor(processor)());

// we now need to get a handle on a ethereum provider
// for this app we are simply using window.ethereum
const ethereum = (window as any).ethereum;

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
		init({provider: ethereum, source: {chainId: '11155111', contracts: [contract]}}, undefined).then(() => {
			indexMoreAndCatchupIfNeeded();
		});
	});
}

function App() {
	const $state = useReadable(state);
	const $syncing = useReadable(syncing);

	return (
		<div className="App">
			<h1>In-Browser Indexer</h1>
			{ethereum ? (
				(() => {
					if ($syncing.lastSync) {
						for (const greeting of $state.greetings) {
							return <p>{greeting.message}</p>;
						}
					} else {
						return <p>Please wait....</p>;
					}
				})()
			) : (
				<p>To test this app, you need to have a ethereum wallet installed</p>
			)}
		</div>
	);
}

export default App;
