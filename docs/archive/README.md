# Archive

These are historical records of how the project was built. They are not current
contracts. Counts, paths, commands and outcomes in them were true when written and
are not kept up to date. For current behaviour, start at
[`docs/README.md`](../README.md).

| Document | What it records |
|---|---|
| [`engineering-log.md`](engineering-log.md) | How each build stage was tested and closed, and how the 0.2.0 and 0.3.0 ports were done. |

## Old stage names

Older records name build stages `S0` to `S10`, and old commands such as
`pnpm s6:drift`. The scripts now use descriptive names:

| Stage | Subject | Current command |
|---|---|---|
| S0 | baseline | `pnpm baseline:gate` |
| S1 | spike, see [`slices/`](../../slices/README.md) | none |
| S2 | storage | `pnpm storage:gate` |
| S3 | memory | `pnpm memory:gate` |
| S4 | profile | `pnpm profile:gate` |
| S5 | catalog | `pnpm catalog:gate` |
| S6 | OpenAPI and SDK | `pnpm openapi:gate`, `pnpm openapi:drift` |
| S7 | MCP | `pnpm mcp:gate` |
| S8 | Hermes | `pnpm hermes:gate` |
| S9 | OpenClaw | `pnpm openclaw:gate` |
| S10 | migration | `pnpm migration:gate` |
