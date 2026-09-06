# `@portable-agent-asset-hub/mcp`

The Model Context Protocol facade. A thin adapter that turns the same
OpenAPI contract used by REST and the SDKs into MCP tools, so any
MCP-capable client (Claude Desktop, an IDE integration, etc.) can call the
hub over stdio.

## What lives here

- **`server.ts`** — the MCP server itself.
- **`stdio-entry.ts`** / **`bin/agent-memory-mcp.mjs`** — the stdio
  transport entry point and the `agent-memory-mcp` CLI shim.
- **`tool-registry.ts`** — builds the list of exposed MCP tools from
  **generated** metadata (see below) rather than hand-declaring them.
- **`generated-tool-metadata.ts`** — generated from the OpenAPI contract's
  `x-mcp.*` extensions (`x-mcp.exposed`, `x-mcp.capability`,
  `x-mcp.safety`). Regenerating this file is checked for reproducibility
  in CI ("MCP tool metadata is reproducible"); it is not hand-edited.
- **`tool-invoker.ts`** — dispatches an incoming MCP tool call to the
  matching REST operation.
- **`rest-transport.ts`** — the HTTP client this package uses to reach the
  REST server. This is the *only* way the MCP facade touches hub state.
- **`capabilities.ts`** — the capability handshake surfaced by
  `GET /api/v1/capabilities`, mirrored for MCP clients.
- **`identity.ts`** — resolves the acting identity for an MCP session.
- **`error-mapper.ts`** — maps REST error responses to MCP error payloads.

## The one rule that matters here

> The MCP server is a thin facade over REST: it never opens a database,
> never reads from disk, and never has a "local mode" fallback. If the
> configured REST base URL is unreachable, the server starts anyway and
> every call fails with a structured transport error.

(from `src/index.ts`.) This is deliberate: it keeps exactly one process
(the REST server, backed by SQLite) as the source of truth, and makes the
MCP facade trivially safe to run alongside REST without risking a second
writer to the database.

Of the 51 OpenAPI operations, 34 are exposed as MCP tools (`x-mcp.exposed:
true`); the remainder — mostly the Graph Explorer's human-facing reads —
are REST-only by design. See the root
[`README.md`](../../README.md#api-surface-at-a-glance) for the full table.

## Build & run

```sh
pnpm --filter @portable-agent-asset-hub/mcp build
node packages/mcp/bin/agent-memory-mcp.mjs
```
