# Documentation index

This index separates the documents that describe how the shipped system
behaves from the historical record and from generated client documentation.
`pnpm docs:check` enforces that every document listed under **Current
contracts** exists and that its relative links resolve.

## Current contracts

| Document | Scope |
|---|---|
| [`architecture.md`](architecture.md) | logical and deployment architecture, boundaries, known defects |
| [`canonical-storage.md`](canonical-storage.md) | storage modes, path resolution, backup and doctor |
| [`skill-relations.md`](skill-relations.md) | canonical relation authority and proposal lifecycle |
| [`skill-graph-retrieval.md`](skill-graph-retrieval.md) | bounded graph retrieval contract |
| [`relation-proposal-workflow.md`](relation-proposal-workflow.md) | governed relation review and apply flow |
| [`web-graph-explorer.md`](web-graph-explorer.md) | Graph UI and BFF behavior, allowlist and security boundary |
| [`runtime-adapters.md`](runtime-adapters.md) | attaching a hub to Codex, Claude Code, OpenCode, Hermes, OpenClaw |
| [`observability.md`](observability.md) | telemetry configuration, privacy and failure model |
| [`../observability/README.md`](../observability/README.md) | Docker Compose operations and the smoke gate |
| [`demo.md`](demo.md) | the end-to-end demo the CI runs on every change |
| [`../CONTRIBUTING.md`](../CONTRIBUTING.md) | development and verification workflow |
| [`../SECURITY.md`](../SECURITY.md) | reporting a vulnerability |

## Architecture decisions

- [`adr/0001-single-sqlite-owner.md`](adr/0001-single-sqlite-owner.md)
- [`adr/0002-portable-v1-exclusions.md`](adr/0002-portable-v1-exclusions.md)
- [`adr/0003-tencent-extraction-boundary.md`](adr/0003-tencent-extraction-boundary.md)
- [`adr/0004-opentelemetry-operational-side-channel.md`](adr/0004-opentelemetry-operational-side-channel.md)

An ADR records a decision at the time it was accepted. Where an ADR describes
something as future work that the current architecture now implements, the
contract documents above take precedence for operational behavior.

## Historical record

[`engineering-log.md`](engineering-log.md) preserves the bounded evidence from
the slices that built this repository — counts, paths and caveats as they were
at the time. Read it as history, not as current runtime state.

## Generated documentation

`packages/sdk-python/generated/` and the generated TypeScript SDK are
projections of [`../openapi/openapi.yaml`](../openapi/openapi.yaml). Regenerate
them through the pinned scripts; never hand-edit generated output.

## Keeping documentation true

When behavior changes:

1. update the OpenAPI or source contract first;
2. update the root [`README.md`](../README.md) and the affected document above;
3. update the Mermaid diagram if a boundary moved;
4. run `pnpm docs:check` along with the affected gates;
5. keep run-specific evidence under the ignored `artifacts/` directory rather
   than embedding volatile ids or timestamps in a current document.
