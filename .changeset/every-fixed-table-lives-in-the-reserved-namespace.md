---
'@etherfold/server': minor
'@etherfold/state-store': patch
'etherfold': minor
---

The server's FIXED tables move into the reserved `_` namespace: `Meta` becomes `_meta` and `EmissionStream` becomes `_emissions` (with its indexes `_emissions_canonical` and `_emissions_by_address_topic`). Nothing about what they CONTAIN changes: same columns, same keys, same two indexes, same semantics.

It closes a silent collision. Entity tables are created as `CREATE TABLE IF NOT EXISTS "<entity.name>"`, and in every combined shape the store and the server share ONE database handle (`buildProcessor`), so a processor declaring an entity called `Meta` or `EmissionStream` issued that DDL against the SERVER's table: `IF NOT EXISTS` made it succeed silently, and the failure surfaced much later as a column error on a write, pointing nowhere near the declaration that caused it.

The mechanism that closes it already existed, and the server's tables were simply outside it. `@etherfold/state-store` reserves the `_` prefix and refuses any entity inside it, and the store's own fixed tables already live there as `_blocks` and `_cursor`. Moving the server's two in makes the collision unreachable by CONSTRUCTION, with no new API, no dependency from the store to the server, and no widening of the entity legality rules. Parameterising the reserved set so a composing host declares its fixed names was considered and rejected: it grows optional API on the store for a guard that is off by default (a browser uses the store with no server at all) and relocates the discipline rather than removing it.

The convention is now a GUARANTEE rather than a memory: a test scans `packages/server/src/schema/sql/db.sql` and fails if any table or index it creates does not begin with `_`, with a guard so an empty or unparsed scan cannot pass it. A fixed table added later without the prefix fails the gate instead of shipping a collision.

There is NO migration and NO compatibility shim. The `schemaVersion` row lives in the table that was renamed, so a database migrated by an older build has no `_meta` and reports the schema as UNAPPLIED, which is the correct signal: those tables really did change. `SCHEMA_VERSION` therefore stays at `2` -- no database can hold a `_meta` row this build did not write.

`EMISSION_STREAM_TABLE` still names the table for a host appending under a name it holds; its value is now `_emissions`. `@etherfold/state-store`'s reserved-identifier refusal is unchanged in behaviour, and its message and docstring now say the prefix means "not a user entity" rather than "the store's", since two packages place tables there. The CLI's reorg counters write to `_meta`.
