---
'ethereum-indexer-server': patch
---

Harden the server HTTP surface (low-severity fixes):

- Routes that hit a not-ready server (`no indexer` / `no processor` / cache disabled) now return a shaped `503` `{error:{code,message}}` body instead of throwing, which Koa turned into a `500` (potentially leaking a stack trace). The mutating routes keep their existing `{error:{code}}` shape.
- The API-key check now uses a constant-time comparison (`crypto.timingSafeEqual`) instead of `Array.includes`, so response timing does not leak the key. Behaviour is otherwise unchanged (valid keys authorize, invalid keys are rejected).
