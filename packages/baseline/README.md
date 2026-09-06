# `@portable-agent-asset-hub/baseline`

Public-surface baseline tooling used by the S0 gate: builds and verifies a
manifest of exactly which files are allowed to be part of the public
export, and validates the input JSON Schemas the contract depends on.

## What lives here (`src/index.ts`)

- **`buildBaselineManifest(root, options)`** — walks a directory root under
  an explicit `allowlist`, applies `DEFAULT_EXCLUSIONS` (`.git`,
  `node_modules`, anything that looks like a secret/token/cookie file,
  etc.), and records `{ path, bytes, mode, sha256 }` for every included
  file. Refuses symlinks anywhere in the walk and refuses any path that
  physically escapes the root (`assertSafeRoot`), so the manifest can't be
  fooled by a symlink pointing outside the tree.
- **`verifyBaselineManifest(root, manifest)`** — re-walks the root and
  checks it against a previously built manifest: every recorded file must
  still match on size/mode/hash, and no extra non-excluded file may exist
  that the manifest doesn't know about. This is what makes "the public
  export contains exactly this and nothing else" a checkable claim rather
  than a policy on trust.
- **`validateBaselineArchiveEntries(entries)`** — the same policy applied
  to entries inside a tarball (used when validating the packed baseline
  fixture) instead of a live directory: rejects symlinks/hardlinks,
  path traversal, and duplicate entries.
- **`validateInputSchemas(directory, options)`** — compiles the four
  canonical input JSON Schemas (`catalog-entry.v2.json`,
  `catalog-relation.v2.json`, `catalog-source.v2.json`,
  `memory-record.v1.json`) with Ajv 2020 and, optionally, checks a set of
  valid/invalid fixtures against them.

## Role in the system

This package backs `pnpm baseline:audit` (`scripts/s0-audit.mjs`) and the
S0 gate — see the root [`README.md`](../../README.md#staged-gates-s0s10).
It is deliberately paranoid about path handling (no symlinks, no
traversal, canonical-path-only) because its entire job is proving a
negative: that nothing outside the declared allowlist made it into the
public export.

## Build

```sh
pnpm --filter @portable-agent-asset-hub/baseline build
```
