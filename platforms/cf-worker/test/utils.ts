import {env, createExecutionContext, waitOnExecutionContext} from 'cloudflare:test';
import worker from '../src/worker.js';

export async function fetchWorker(req: string, init?: RequestInit): Promise<Response> {
	const url = req.startsWith('http') ? req : `http://example.com${req.startsWith('/') ? req : `/${req}`}`;
	const request = new Request(url, init);
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}
