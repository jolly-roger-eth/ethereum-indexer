# ethereum-indexer-db-utils

## Unreleased, and never will be

This package retired under ADR-0010 before these changes were released, and it moved to `archive/` outside the workspace. It had no changeset of its own; it was named by four that also covered packages which were renamed and will ship under their new names. Those changesets stopped naming this one when the release path was cleared, since a changeset naming a package that is not in the workspace makes `changeset status` and any release fail outright. See `archive/README.md`.

### Patch Changes

- The ESM-only `tsc` build (`dist/*.cjs` and `main` removed, `NodeNext` resolution), the viem v2 dependency update, and the shared `isBigIntLiteral` / `simple_hash` guard that replaced this package's own copy of the `"123n"` BigInt reviver. Released under `@etherfold/*`; never released here.

## 0.6.21

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.21

## 0.6.20

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.20

## 0.6.19

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.19

## 0.6.18

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.18

## 0.6.17

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.17

## 0.6.16

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.16

## 0.6.15

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.15

## 0.6.14

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.14

## 0.6.13

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.13

## 0.6.12

### Patch Changes

- latest deps
- Updated dependencies
  - ethereum-indexer@0.6.12

## 0.6.11

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.11

## 0.6.10

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.10

## 0.6.9

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.9

## 0.6.8

### Patch Changes

- reorg + add streams server (wip)
- Updated dependencies
  - ethereum-indexer@0.6.8

## 0.6.7

### Patch Changes

- improve processor import to work in pnpm + startBlock fix
- Updated dependencies
  - ethereum-indexer@0.6.7

## 0.6.6

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.6

## 0.6.5

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.5

## 0.6.4

### Patch Changes

- Updated dependencies [c81fb4d]
  - ethereum-indexer@0.6.4

## 0.6.3

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.3

## 0.6.2

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.2

## 0.6.1

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.1

## 0.6.0

### Minor Changes

- release

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.0
