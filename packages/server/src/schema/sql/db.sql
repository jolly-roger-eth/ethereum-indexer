-- FIXED tables only.
--
-- Entity tables are NOT here and never will be: the versioned-row state store
-- creates them at runtime from whatever entities a processor declares, so its
-- DDL is dynamic by construction. See docs/design/historical-state-database.md
-- and the state-store-sqlite package. This file is the part of the schema the
-- SERVER owns and can therefore ship as static SQL.
CREATE TABLE IF NOT EXISTS Meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- The version row lives HERE, in the SQL, rather than being written by the code
-- that applies it. Both application paths must produce the same database, and
-- one of them is not ours: wrangler's D1 migrations execute these files and
-- nothing else. When the version was recorded in TypeScript, a D1-migrated
-- database came up with the table present and no version row, and reported
-- itself unhealthy forever. Keep this row in step with SCHEMA_VERSION in
-- schema.ts; a test asserts they agree.
INSERT INTO Meta (key, value) VALUES ('schemaVersion', '1')
    ON CONFLICT (key) DO UPDATE SET value = excluded.value;
