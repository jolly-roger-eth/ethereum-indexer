import './index.css';
import 'named-logs-console';
import App from './App.svelte';

const app = new App({
	target: document.getElementById('app')!,
});

export default app;
