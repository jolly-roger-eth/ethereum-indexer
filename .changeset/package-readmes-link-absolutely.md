---
'@etherfold/core': patch
'@etherfold/browser': patch
'@etherfold/processor-entities': patch
'@etherfold/processor-sqlite': patch
'@etherfold/state-store': patch
'@etherfold/state-store-sqlite': patch
'@etherfold/state-store-indexeddb': patch
'@etherfold/state-store-patch': patch
'@etherfold/state-store-conformance': patch
'@etherfold/server': patch
'@etherfold/fetcher-host': patch
'@etherfold/utils': patch
'@etherfold/platform-nodejs': patch
'@etherfold/platform-nodejs-fetcher': patch
'etherfold': patch
---

Package READMEs now link to sibling packages by absolute URL instead of by relative path.

A README is read in three places and a relative `../state-store` link is only correct in one of them. On npmjs.com it resolves against the registry page and 404s, so every cross-reference in every published README was broken for the audience most likely to follow one. In the generated API documentation the same links became `_media/<package>` references to files that do not exist, which is what turned the docs site's build red.

No prose changed; only the link targets.
