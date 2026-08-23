# ADR-0016's `processor-js` rename never happened

2026-08-23, noticed while writing ADR-0018.

ADR-0016 says `ethereum-indexer-js-processor` migrates to `<scope>/processor-js`, so that one role's variants sort adjacent. ADR-0017's rename to `etherfold` then published it as `@etherfold/js-processor`, keeping the old word order, and nothing records the reversal. So two accepted ADRs name the same package differently and the shipped name is the one ADR-0016 argues against. Out of scope here (ADR-0018 just footnotes it); worth either finishing the rename or amending ADR-0016.
