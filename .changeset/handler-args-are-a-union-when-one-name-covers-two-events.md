---
'@etherfold/js-processor': minor
'@etherfold/processor-entities': minor
---

`on<EventName>` handler args are now a UNION when one event name covers two wire events, instead of the two input lists MERGED.

An upgraded contract can emit `Transfer(address,address,uint256)` before the upgrade block and `Transfer(address,address,uint256,bytes)` after it. They share a name, so `ExtractAbiEventNames` collapses them and the author writes one `onTransfer` -- which is fine. What was not fine is what `args` said about it: `InputValues` mapped over the extracted event with `T` taken WHOLE, so the mapped type did not distribute and the two input lists merged into `{from, to, id, memo}` with `memo` REQUIRED. A pre-upgrade log then handed the author `undefined` through a type promising a value, with no cast and no warning anywhere.

`InputValues` now distributes, in both authoring packages, which each hold their own copy. `event.args.memo` no longer compiles un-narrowed; `if ('memo' in event.args)` narrows to the version that has it, shared fields included.

A single-version ABI -- every processor written today -- is unaffected: distributing over a non-union is the mapped type itself, and that is pinned as a type-identity assertion rather than assumed. Handler keys stay NAME-based; a signature-keyed alias (`on['Transfer(address,address,uint256,bytes)']`) is a later addition and would remove nothing.

Both directions run under `pnpm typecheck` (`@ts-expect-error` as the assertion), since vitest strips types without checking them.
