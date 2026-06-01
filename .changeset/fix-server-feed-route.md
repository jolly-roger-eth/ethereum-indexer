---
'ethereum-indexer-server': patch
---

Fix the `/feed` route reading the request body from the wrong place. It read `ctx.body.events` (the response body, always `undefined` here) instead of `ctx.request.body.events`, so every real `/feed` call threw `Cannot read properties of undefined (reading 'events')` and the route was effectively dead. It now reads the `events` array from the request body, validates it is an array (returning a shaped `{error:{code:4000}}` Bad Request instead of throwing a 500 when it is missing/not an array), and forwards it to `indexer.feed`.

Also adds an optional `createProvider?: (nodeURL) => provider` factory to the server config (defaults to the existing `new JSONRPCHTTPProvider(nodeURL)`, so behaviour is unchanged when omitted; useful for injecting a custom provider or a fake in tests), and makes the admin page template load lazily instead of at module import time.
