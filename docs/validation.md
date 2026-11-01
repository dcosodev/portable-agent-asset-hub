# Validation

## What is enforced

CI ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)) runs these on every
pull request and every push to `main`:

| Check | Command |
|---|---|
| Documentation check | `pnpm docs:check` |
| Lint, root and `graph-ui` | `pnpm lint`, `pnpm --filter @portable-agent-asset-hub/graph-ui lint` |
| Typecheck | `pnpm typecheck` |
| Tests, root and `graph-ui` (builds first) | `pnpm test` |
| OpenAPI drift | `pnpm openapi:drift` |
| Telemetry source rules | `pnpm observability:lint` |
| Compose and Collector configuration, no daemon | `pnpm docker:contract` |
| MCP tool metadata regenerates identically | `SOURCE_DATE_EPOCH=0 node scripts/generate-mcp-tools.mjs`, then `git diff --exit-code` |
| End-to-end demo | `node examples/demo/demo.mjs` |

`pnpm docs:check` checks that the listed documents exist, that their relative links
resolve, and that they make no known stale schema or contract claim. It does not
check prose.

`graph-ui` is outside the root `tsconfig.json` project references because it compiles
JSX under its own configuration, so the root commands run it as a separate step.

## Other local commands

| Command | Purpose | Needs |
|---|---|---|
| `pnpm build` | Clean `dist/`, run `tsc -b --force`, copy the SQL migrations, build `mcp` and `graph-ui`. | |
| `pnpm audit` | `pnpm audit --prod` over production dependencies. | Network |
| `pnpm baseline:audit` | Check the public fixture against its manifest. | |
| `pnpm run pack` | Build the publishable tarball (`scripts/root-package-pack.mjs`). | |
| `pnpm observability:contract` | Telemetry privacy, cardinality, fail-open, config and noop tests. | |
| `pnpm docker:smoke` | Build both images and drive the live observability stack. | Docker daemon |
| `pnpm sdk:generate` | Regenerate the SDKs. | Java 17, OpenAPI Generator `7.10.0` |

## Local gates

The gates are longer Node scripts in [`scripts/`](../scripts/). CI does not run them.
**They are not all green at present:** the chained gates currently exit with a
failure on a fresh machine, for reasons that include stale expectations in the
scripts, open dependency advisories and environment assumptions. Do not read a gate
listed here as passing validation. Use a gate as a detailed check of one surface, and
read its evidence to see which step failed.

| Command | Covers |
|---|---|
| `pnpm baseline:gate` | Public-surface policy, the baseline tarball and pack reproducibility. |
| `pnpm storage:gate` | Storage contract, migrations, doctor, backup, package reproducibility and external install. See [`storage-contract.md`](storage-contract.md). |
| `pnpm memory:gate` | Memory contracts, schemas and fresh replay. |
| `pnpm profile:gate` | Profiles and materialization. |
| `pnpm catalog:gate` | Catalog sync, including apply, adversarial cases and a fresh process. |
| `pnpm openapi:gate` | OpenAPI contract, SDK generation and drift. |
| `pnpm mcp:gate` | MCP server, its tool metadata and schema match. |
| `pnpm hermes:gate` | Hermes contracts, REST integration, materialization and rollback. |
| `pnpm openclaw:gate` | OpenClaw contracts and REST integration. |
| `pnpm migration:gate` | Migration safety, replay, cutover and rollback. |

Related single steps are `pnpm package:repro`, `pnpm storage:external-install`,
`pnpm storage:fresh-backup`, `pnpm memory:external-install` and
`pnpm catalog:fresh-process`. Separate from the chain, `pnpm observability:gate`
covers telemetry and `pnpm docker:gate` runs `docker:contract` and `docker:smoke`.

Most gates re-run earlier gates as regressions, so one early failure fails the later
gates as well. Within one top-level command, each gate runs once:
[`scripts/run-gate.mjs`](../scripts/run-gate.mjs) replays a repeat's recorded result,
including a failure, if the tree and the gate's evidence are unchanged. Nothing is kept
between commands, and `GATE_NO_REUSE=1` runs every repeat for real.

A gate stops with a failure when a required tool is missing, rather than continuing
with less coverage. `pnpm openapi:gate` fails without Java 17 and OpenAPI Generator
`7.10.0`, and generated SDKs are never replaced with placeholders. Each SDK tree's
`PROVENANCE.json` records the pinned tool, its version and the source contract.

### Evidence

Gates write results under `artifacts/`, which Git ignores, with per-run snapshots and
logs under `artifacts/.evidence/`. Evidence holds command status, exit codes, digests
and assertion counts, not payload bodies or secrets. A failed run stays failed even if
a later run passes, because each run has its own ID and path.
