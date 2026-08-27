# Changelog

All notable public changes will be documented here.

## 0.2.0 — 2026-08-27

Second public release. It lifts the consolidated skills, skill-graph and
relation work out of the private development repository. The in-flight
OpenTelemetry/Docker observability stack and the relation auto-approval slice
are deliberately **not** included: they are not yet consolidated.

### Removed (BREAKING)

- **`listSkills` (`GET /api/v1/skills`) and `listSkillVersions`
  (`GET /api/v1/skills/{id}/versions`) are removed** from the HTTP contract and
  from the MCP tool surface. The canonical skill surface is now read-only and
  consists of `searchSkills`, `getSkill`, `listSkillResources` and
  `readSkillResource`. There is no deprecation window: 0.1.0 was the first
  tagged release and these operations had no stable consumer.
  - Callers of `GET /api/v1/skills` should move to `GET /api/v1/skills/search`.
  - Callers of the version list should use `getSkill`, which returns the
    version head.
  - The generated MCP tools `list_skills` and `list_skill_versions` disappear
    with them. An MCP client that hardcodes those names will fail at tool
    discovery rather than receive an error response.
  - The regenerated TypeScript and Python SDKs drop the corresponding client
    methods and models.

### Added

- **30 new operations (23 → 51)**: skills and skill resources, the canonical
  skill graph, mandatory retrieval and the retrieval-event explorer, relation
  proposals, explicit relation candidates, `getCapabilities`, `searchMemories`,
  `getMemory` and `searchCatalog`. 34 of the 51 are exposed as MCP tools; the
  graph and retrieval reads are a human REST surface (`x-mcp.exposed: false`).
- **Skills as first-class, DB-owned assets**: skill entries, immutable integer
  versions, byte-exact resources, catalog FTS, and a skill-pack importer with
  secret scanning. Migrations `0014_catalog_fts`, `0015_skills`,
  `0016_skill_graph_retrieval`.
- **Versioned skill graph and mandatory retrieval**: eight canonical relation
  types held in a domain registry, bounded structural expansion, immutable
  version resolution, and an append-only `retrieval_events` audit whose stored
  query is redacted. See `docs/skill-graph-retrieval.md`.
- **Governed relation proposals**: discovery, manual creation, review, apply
  preview, batch apply and duplicate reconciliation. Discovery and explicit
  `related_skills` metadata produce candidates, never canonical edges; only a
  reviewed plan digest writes `skill_relations`. Migrations
  `0018_relation_proposals`, `0019_relation_proposal_review`. See
  `docs/skill-relations.md` and `docs/relation-proposal-workflow.md`.
- **`@portable-agent-asset-hub/runtime-adapters`** — preview/apply/rollback
  adapters for Codex, Claude Code, OpenCode, Hermes and OpenClaw, with path
  containment, safe file modes and no secrets in descriptors. See
  `docs/runtime-adapters.md`.
- **`@portable-agent-asset-hub/skill-export`** — deterministic focal and full
  skill export with canonical relation manifests.
- **`@portable-agent-asset-hub/graph-ui`** — read-only Web Graph Explorer
  (React, Vite, Cytoscape.js) behind a loopback BFF that never opens SQLite.
  See `docs/web-graph-explorer.md`.
- **Runtime credential bindings** (`runtime_credentials`, migration
  `0017_runtime_credentials`) and the `GET /api/v1/capabilities` handshake.
  Bearer values are never stored; `createCredential` returns the token once and
  later metadata carries only its fingerprint.
- **Capability-gated REST routes** and storage-mode resolution
  (canonical / temporary / test); canonical writes are refused when the
  resolved mode is temporary or test. See `docs/canonical-storage.md`.
- REST and MCP stdio launchers with `bin/` entry points
  (`agent-memory-rest`, `agent-memory-mcp`).
- 30 new test files. The suite is now 561 tests (541 in the workspace plus 20
  in `graph-ui`), up from 272.
- English documentation for the new surfaces: `docs/architecture.md`,
  `docs/skill-relations.md`, `docs/skill-graph-retrieval.md`,
  `docs/relation-proposal-workflow.md`, `docs/runtime-adapters.md`,
  `docs/web-graph-explorer.md`, `docs/canonical-storage.md`.

### Changed

- Schema version 13 → 19. `getStatus` and `getCapabilities` advertise it from
  a single `SCHEMA_VERSION` constant in `@portable-agent-asset-hub/rest`
  instead of two inline literals.
- `scripts/generate-mcp-tools.mjs` honors `SOURCE_DATE_EPOCH`, so generated
  tool metadata is reproducible. CI now gates on it.
- `scripts/generate-sdks.mjs` normalizes generator-owned text so repeated
  generation is diff-clean.
- `scripts/package-repro.mjs` links workspace siblings between packed
  packages; `scripts/external-install-s2.mjs` extends coverage to
  `storage-files`; `scripts/s0-package-check.mjs` compares `package.json` with
  stable key ordering.
- `@portable-agent-asset-hub/rest` gained the project references it actually
  needs (`storage-files`, `storage-sqlite`), and its `bin` shim resolves the
  package-local `dist/` that 0.1.0 moved it to.
- `packages/graph-ui/dist-server/` is build output and is no longer committed;
  `pnpm --filter graph-ui start` builds first.

### Fixed

- `tests/s6-generate-sdks.test.ts` no longer regenerates the real
  `packages/sdk-*/generated` trees when the pinned toolchain is present. That
  wipe-then-generate window raced `tests/s6-sdk-drift.test.ts` reading the same
  tracked files from a sibling worker, making the suite intermittently red. The
  success path is still covered deterministically against a scratch repo.

## 0.1.0 — 2026-08-22

First tagged public release.

### Fixed

- Materializer rollback now honors the documented added-file contract:
  `applyPlan` records a `.deleted` marker for every file it writes over
  no prior bytes, and `rollbackPlan` (and the apply failure path) removes
  those files instead of leaving them behind. Previously, rolling back an
  apply onto an empty target restored nothing (`restored: []`) and left
  the applied — or tampered — files in place. Covered by a new E2E test.
- `@portable-agent-asset-hub/rest` now builds to its own `dist/` like
  every other package, so its `package.json` entry points resolve under
  plain Node (they previously pointed at a directory that only existed
  in the repository-root `dist/` tree).

### Added

- End-to-end demo (`examples/demo/demo.mjs`, documented in
  `docs/demo.md`): profile → REST preview → 428 without CAS → apply →
  412 on drift → rollback, fully local.
- REST route table: unknown method on a known path answers
  `405 METHOD_NOT_ALLOWED` with an `Allow` header (previously 404), the
  201-on-create rule is an explicit operation set instead of an
  `operationId` prefix heuristic, and path parameters support named
  capture groups. `OperationId` is exported as a type derived from the
  route table, typing `RestHub.dispatch`.
- GitHub Actions CI workflow running the fast checks (lint, typecheck,
  tests) and the demo. Staged gates `s0`–`s10` remain local.
- Consolidated engineering log (`docs/engineering-log.md`), full-form
  ADRs, and `slices/README.md`.

### Initial public export

- Prepared a public portfolio export of the Portable Agent Asset Hub.
- Added Apache License 2.0 metadata and notices for the public source tree.
- Added public-surface documentation, contribution guidance, security policy and issue/PR templates.
- Kept personal skills, runtime state, private baselines and local evidence outside the publication candidate.
