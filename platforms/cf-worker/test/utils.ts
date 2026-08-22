import {env, createExecutionContext, waitOnExecutionContext} from 'cloudflare:test';
import worker from '../src/worker.js';

export const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

export async function fetchWorker(req: string, init?: RequestInit): Promise<Response> {
	const url = req.startsWith('http') ? req : `http://example.com${req.startsWith('/') ? req : `/${req}`}`;
	const request = new IncomingRequest(url, init as never);
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env as never, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}
