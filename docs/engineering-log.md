# Engineering log

This document records how the hub was built and validated, stage by stage.
It consolidates the working TDD logs kept during development into one
narrative, with the project's vocabulary defined up front.

## Methodology

The project was built in **stages (S0–S10)**, each closed by a
**fail-closed gate**: a local Node script under [`scripts/`](../scripts/)
that runs every required check (lint, typecheck, targeted and full tests,
build, owner scan, package reproducibility, external install, regression
of earlier gates) and writes evidence under `artifacts/`. Evidence is
written `PENDING` (or `NO-GO`) *before* execution and only becomes `PASS`
when every named step passes; a failed invocation remains a failure even
if a later run passes, because later runs get separate IDs and evidence
paths.

Within each stage, work followed **RED → GREEN** test-driven cycles: a
failing test (RED) is written and its real failure recorded before the
implementation that turns it GREEN. The logs below preserve those recorded
failures deliberately — they are evidence that the tests fail for the
right reason, not decoration.

### Glossary

| Term | Meaning |
| --- | --- |
| **Stage (S0–S10)** | A scoped increment of the system with its own gate. S0 public-surface policy → S2 storage/contract core → S3 memory → S4 profiles/materialization → S5 catalog sync → S6 SDK generation → S7–S9 integration evidence → S10 migration safety. |
| **Gate** | The fail-closed script closing a stage (`pnpm sN:gate`). Gates also re-run earlier stages' gates as regressions in an isolated copy. |
| **Fail-closed** | Missing tools, missing evidence, or drift produce a hard failure, never a silent downgrade (e.g., S6 fails when Java 17 or OpenAPI Generator 7.10.0 is absent, rather than shipping placeholder SDKs). |
| **RED / GREEN** | A recorded failing test run / the run after implementation where the same suite passes. |
| **Slice / spike** | An isolated, throwaway-by-default exploration outside the workspace; see [`slices/README.md`](../slices/README.md). |
| **Owner scan** | Enforcement of ADR 0001 (only `storage-sqlite` may open SQLite). |
| **Evidence** | Per-invocation JSON snapshots plus stdout/stderr digests under `artifacts/` (`.evidence/` is Git-ignored; command status and assertion counts are recorded, never payload bodies or secrets). |

## S2 — storage core and packaging contract

The S2 contract itself is documented in [`s2-contract.md`](s2-contract.md).

- **RED (real baseline):** 13 assertions / 7 contractual failures against
  the pre-S2 implementation. The initial schema RED also exposed that only
  the identity schema was being compiled, and an import incorrectly pulled
  `readFileSync` from `node:fs/promises`.
- **GREEN:** `pnpm exec vitest run tests/s2` — 14 tests, including AJV
  Draft 2020-12 compilation of identity, binding, and capabilities schemas
  against valid and invalid fixtures, plus stale gate-state coverage.
  `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm s0:gate`,
  and `pnpm s2:gate` all passed.
- **Packaging RED/GREEN:** isolated package trees are packed twice with
  `npm pack` and compared by sorted logical paths and per-path byte SHA
  (not tar metadata), covering JS, `.d.ts`, and the SQL migrations.
- **External-install GREEN:** both local tarballs resolve in one temporary
  package installation with the registry disabled — no npm lookup for
  core, no shared or symlinked `node_modules`.
- **Backup GREEN:** the backup manifest SHA is checked and a separate Node
  process opens the backup and runs doctor; cleanup runs in `finally`, and
  destination-overwrite, same-path, and symlink cases fail closed.

## S3 — memory surface

- **RED:** `tests/s3-memory.test.ts` failed because `tx.events` /
  `tx.memories` did not exist yet (`Cannot read properties of undefined`).
- **RED:** a new FTS-head assertion used an unquoted hyphenated term
  (`new-head`), which SQLite FTS parsed as a column expression — a real
  query-syntax bug caught by the test before it could reach the
  implementation.
- **GREEN:** 16 targeted tests passed; `pnpm s2:gate` regression passed
  (48 full tests); `pnpm s3:gate` completed `PASS` with lint, typecheck,
  full tests, build, owner scan, fresh replay, package reproducibility,
  external install, audit, and S2 regression all green. Recorded limits:
  `nodeSqliteExperimental=true`, `rawBodiesCaptured=false`.

## S4 — profiles and materialization

- **RED:** `tests/s4-profiles.test.ts` failed at collection because
  `storage-files` and the S4 profile APIs did not exist.
- **GREEN cycles:** profile scope/CAS/version repository and deterministic
  materialization (8 nominal tests), then preview parsing/digest/drift
  guards and filesystem containment plus an atomic writer (8/8).
- Migration `0012` entered the checksummed runner and the build copy step.
- **Limitation recorded at the time:** the minimal S4 implementation did
  not yet expose a transactional profile facade through
  `StorageTransaction`, and the S4 gate covered the nominal tracer tests
  only. The adversarial and reproducibility coverage arrived with S5
  (below), which re-runs S4 as a regression.

## S5 — catalog sync

- **RED:** `tests/s5-catalog.test.ts` failed on missing `logicalKey`,
  `canonicalDigest`, `sanitizeMetadata`, and `SyncService` exports.
- **GREEN:** the core catalog tracer passed 4/4 after implementing stable
  logical keys, canonical digests, metadata sanitization, and a
  deterministic scan preview; typecheck, lint, and build passed with the
  migration copy step now at 13 SQL migrations.
- **Transient regression (resolved):** adding migration `0013` briefly
  broke a legacy S2 test that asserted exactly 12 migrations, which also
  failed `pnpm s4:gate` closed through its regression steps. The
  expectation was updated to the new canonical count;
  `tests/s2/integrity-and-boundaries.test.ts` now asserts 13 and the full
  suite passes (268 tests at the time of this export).
- **RED (adversarial, bypass reproduced):** `tests/s5-adversarial.test.ts`
  proved a post-review byte mutation was accepted — the exact bypass the
  stage exists to prevent.
- **GREEN:** persisted plans now contain only sanitized locators/metadata
  plus a SHA-256 `contentDigest`; apply re-scans and rejects
  content/set/root/input/catalog/profile/target drift without persisting a
  second preview. `FileSyncMarker` performs strict containment checks and
  atomic exclusive-temp publication; `CatalogSyncCoordinator` derives
  actor/profile/scope fingerprints server-side and wraps the filesystem
  marker outside the SQLite transaction.
- **GREEN:** `tests/s5-coordinator.test.ts` proves real-file replay
  idempotency, target-drift rejection, and that a post-publication failure
  restores the exact prior bytes with zero catalog/audit/applied DB
  effects; `failure_rolls_back_entries_sources_audit_and_marker` proves a
  failure after catalog mutation and marker publication restores the
  marker and rolls back SQLite and audit state.
- **GREEN gate:** `pnpm s5:gate` completed `PASS` with 19 targeted
  assertions; full tests, fresh process/doctor, package reproducibility,
  external offline install (which creates real source files and exercises
  preview → review → apply/replay), audit, and S4 regression all passed.

## S6 — SDK generation

S6 generates the TypeScript and Python SDKs from the OpenAPI contract with
OpenAPI Generator 7.10.0 (requires Java 17). The gate is fail-closed by
design: when Java or the exact generator version is absent, generation
fails with an honest `PROVENANCE.json` rather than emitting placeholders —
and that behavior itself is under test
(`tests/s6-generate-sdks.test.ts`). Drift between the contract and the
generated trees is detected by `pnpm s6:drift`.

## 0.2.0 — skills, skill graph and governed relations

The 0.2.0 surface was developed in a private repository and lifted here as a
single consolidated cut. Two decisions shaped what shipped.

**The cut is the private repository's HEAD, not its working tree.** The working
tree carried a mid-flight migration (`0020_relation_proposal_auto_approval`)
that had bumped the migration runner to 20 while three committed tests still
asserted 19 — an internally inconsistent state. HEAD was self-consistent,
telemetry-free, and complete through migration 0019, so that is what was
ported. The OpenTelemetry/Grafana stack, the Docker stack, the relation
auto-approval slice and a graph-ui component refactor all live only in that
working tree and are therefore absent from 0.2.0. They are not rejected work;
they are unconsolidated work.

**The port was a three-way merge, not a copy.** The private repository's initial
commit is a true merge base for the 0.1.0 public export: of the 384 shared
files, 356 were byte-identical at that base and 28 differed — and those 28 were
exactly the sanitization and licensing edits made during the export. That made
the bulk of the merge mechanical (`git merge-file --diff3` per file) and
isolated the files needing judgement.

Three of those needed a genuine hand-merge, because the public repository was
*ahead*: `packages/materializers/src/apply.ts` and `rollback.ts` carried the
0.1.0 added-file rollback fix that the private HEAD predated, and
`packages/rest/src/app.ts` carried the 405 + `Allow` route table, the explicit
201-on-create set and the typed `OperationId`. Taking the private version
wholesale would have silently reintroduced two fixed bugs. The merged `app.ts`
keeps the public hardening and layers on the private capability gate,
`getCapabilities`, `paramNames` path decoding and the malformed-percent-encoding
guard.

Four scripts were kept at the public version for the same reason — they carry
the de-personalization done at export time (`generate-s0-artifacts.mjs`,
`s0-trust-anchor.mjs`, `s0-audit.mjs`, `package-private-policy.mjs`) — while
`generate-sdks.mjs` was merged: the private tree's diff-clean normalization on
top of the public `PATH:${cliName}` provenance form. The SDKs were then
*regenerated* rather than copied, so `PROVENANCE.json` records the sanitized
resolution natively instead of being scrubbed after the fact.

### RED found during the port

- **Missing project references.** `storage-sqlite` imports `storage-files`, and
  `rest` imports both, but neither `tsconfig.json` declared the reference. The
  private repository masked this with per-package `build` scripts; a clean
  `tsc -b` did not. Fixed by declaring the references.
- **`bin` shim pointed at the wrong `dist`.** 0.1.0 moved `rest` to build into
  its own `dist/`; the ported `bin/agent-memory-rest.mjs` still resolved the
  repository-root `dist/packages/rest/`. The launcher-backed suites timed out
  until the shim was repointed and its now-dead workspace symlink block removed.
- **A test that raced itself.** `tests/s6-generate-sdks.test.ts` pointed the
  generator at the real repository root, and `runGenerator` wipes
  `packages/sdk-*/generated` before it writes. With the pinned toolchain present
  that window is seconds long and raced `tests/s6-sdk-drift.test.ts` reading the
  same tracked files from a sibling worker. It reproduced roughly one run in two
  under `CI=true`. The destructive invocation is now confined to the fail-closed
  branch, where the script exits 2 without regenerating anything.

### Verification

Green: `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test` (541 workspace
+ 20 graph-ui), `pnpm s0:gate`, `pnpm s6:drift`, reproducible MCP tool
generation, `pnpm s6:generate`, and `node examples/demo/demo.mjs`. Three
consecutive `CI=true` full-suite runs were green, confirming the race fix.

Not green, and not caused by the port: `s2:gate` through `s5:gate` all chain
into the `S1-copy` step, which runs the S1 slice gate. That gate reads a pinned
upstream checkout at `/tmp/tencentdb-agent-memory-review`, whose `.git`
directory is missing `HEAD` and `config` on the machine used for this port. The
`slices/` tree is byte-identical to 0.1.0. Every other step of those gates
passes.

## Recording policy

Payload bodies and secret values are never recorded in gate evidence or in
this log; evidence consists of command status, exit codes, digests, and
assertion counts only.
