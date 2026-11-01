# Documentation index

This index separates the documents that describe how the shipped system
behaves from the historical record and from generated client documentation.
`pnpm docs:check` checks that these documents exist and that their relative
links resolve.

## Current contracts

| Document | Scope |
|---|---|
| [`architecture.md`](architecture.md) | system map, what ships, subsystems, boundaries |
| [`api-surface.md`](api-surface.md) | every REST operation, its safety class and whether it is an MCP tool |
| [`packages.md`](packages.md) | workspace packages and repository layout |
| [`validation.md`](validation.md) | what CI enforces, other local commands, and the state of the local gates |
| [`storage-contract.md`](storage-contract.md) | public surface of core and SQLite storage, packaging, and the storage gate |
| [`architecture/go-product-shell.md`](architecture/go-product-shell.md) | the Go `hub` CLI |
| [`canonical-storage.md`](canonical-storage.md) | storage modes, path resolution, backup and doctor |
| [`skill-relations.md`](skill-relations.md) | canonical relation authority and proposal lifecycle |
| [`skill-graph-retrieval.md`](skill-graph-retrieval.md) | bounded graph retrieval contract |
| [`relation-proposal-workflow.md`](relation-proposal-workflow.md) | governed relation review and apply flow |
| [`web-graph-explorer.md`](web-graph-explorer.md) | Graph UI and BFF behavior, allowlist and security boundary |
| [`runtime-adapters.md`](runtime-adapters.md) | attaching a hub to Codex, Claude Code, OpenCode, Hermes, OpenClaw |
| [`observability.md`](observability.md) | telemetry configuration, privacy and failure model |
| [`../observability/README.md`](../observability/README.md) | Docker Compose operations and the smoke gate |
| [`demo.md`](demo.md) | the end-to-end demo the CI runs on every change |
| [`faq.md`](faq.md) | answers to the questions the repository's own validation output raises most often |
| [`../CONTRIBUTING.md`](../CONTRIBUTING.md) | development and verification workflow |
| [`../SECURITY.md`](../SECURITY.md) | reporting a vulnerability |

## Package READMEs

Each workspace package under `packages/` has its own README with a
file-by-file breakdown. They are linked from [`packages.md`](packages.md).

## Architecture decisions

- [`adr/0001-single-sqlite-owner.md`](adr/0001-single-sqlite-owner.md)
- [`adr/0002-portable-v1-exclusions.md`](adr/0002-portable-v1-exclusions.md)
- [`adr/0003-tencent-extraction-boundary.md`](adr/0003-tencent-extraction-boundary.md)
- [`adr/0004-opentelemetry-operational-side-channel.md`](adr/0004-opentelemetry-operational-side-channel.md)

An ADR records a decision at the time it was accepted. Where an ADR describes
something as future work that the current architecture now implements, the
contract documents above take precedence for operational behavior.

## Historical record

[`archive/`](archive/README.md) holds records of how the repository was built,
with counts, paths and caveats as they were at the time. Read them as history,
not as current behaviour. [`../slices/README.md`](../slices/README.md) records the
spike that came before the main workspace.

## Generated documentation

`packages/sdk-python/generated/` and the generated TypeScript SDK are
projections of [`../openapi/openapi.yaml`](../openapi/openapi.yaml). Regenerate
them through the pinned scripts; never hand-edit generated output.

## Keeping documentation true

When behavior changes:

1. update the OpenAPI or source contract first;
2. update the root [`README.md`](../README.md) and the affected document above;
3. update the Mermaid diagram if a boundary moved;
4. run `pnpm docs:check`, along with any gate for the surface you changed;
5. keep run-specific evidence under the ignored `artifacts/` directory rather
   than embedding volatile ids or timestamps in a current document.
