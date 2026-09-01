# The named indexer replaces the project axis

A server, a CLI and a browser app all need to hold more than one indexed dataset at once, and an earlier design gave that a **project** axis sitting ABOVE the indexer. That axis is **DELETED rather than renamed**: once an indexer is one chain and one answer set, `project` and `indexer` are the same unit, and the glossary already said so in every place that counted (an indexer holds several generations, one is canonical, and the caps are per indexer). The unit is a **NAMED INDEXER**, its name is the top level of every stream address, and on a server it is a structurally non-omittable part of every read and write.

## Considered Options

- **`project` as a separate axis above the indexer (the earlier design).** Rejected once it was clear it never carried an independent fact: every project held exactly one answer set, which is what an indexer already is. Keeping it meant a two-part key in every address, route and pointer, `/{project}/{chainId}/graphql` rather than `/{indexer}/graphql`, and two chances to omit a discriminator instead of one.
- **`instance`.** Available (24 files use the word, all generic prose), but filler: it implies a running copy when this thing persists with nothing running, and "indexer instance" is a longer way of saying "indexer".
- **`dataset`.** Completely unused, accurate for the read side, but it invents a word where one already existed and downplays the live indexing.
- **`deployment`.** Already taken twice over (the fetcher/server topology, and a browser installation).

## Consequences

- **The name is UNIVERSAL, not a server concept.** One discriminator, two sources for its value: an operator supplies it on `upload`, and a browser app supplies it directly. The browser case is not hypothetical — an app watching several accounts (an NFT viewer) names one indexer PER WATCHED ADDRESS.
- **That is NOT a generation.** A generation is an EVOLUTION of one logical thing with ONE canonical answer. Parallel, equally-valid datasets with no canonical among them are separate INDEXERS. A filter that identifies a different SUBJECT is a different indexer; a filter change that refines the SAME subject is a new generation of it. Getting this backwards argues for changing the browser retention default, which on inspection is correct as it stands.
- **One name is one chain at a time**, and `chainId` is deliberately not an address component anywhere: it is already inside the stream digest via the block-0 skeleton entry (`sourceSkeletonOf` hashes `chainId` and `genesisHash`), so two chains produce different digests and cannot collide. Two chains live at once are two names. Two contract deployments on one chain are likewise two names, since one canonical pointer can only name one generation.
- **Changing an indexer's chain is an ordinary reconfigure**, not a special case: it moves the skeleton entry, hence the source hash, hence the STREAM, so it makes a new generation with the old one retained under the caps and revertible. This is thegraph's "a named subgraph can change its chain on redeploy", with rollback it does not have.
- **The name is the top level of the stream address** (`['stream', <indexer-name>, <streamDigest>, <ordinal>]`), so no runtime needs an additional discriminator, and on the server it is a column on the emission table that no read may omit.

Recorded because the rationale otherwise lived only in a `CONTEXT.md` glossary entry, which is the wrong bucket by this repo's own rule, and in specs whose banner says they are not maintained.
