// import './app.css';
import {mount} from 'svelte';
import 'named-logs-console';
import App from './App.svelte';

const app = mount(App, {
	target: document.getElementById('app')!,
});

export default app;
