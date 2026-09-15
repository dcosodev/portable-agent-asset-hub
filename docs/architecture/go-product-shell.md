# Go product shell — signature and boundaries

The Go shell (`hub`) is the operator-facing control plane. It does not
own domain state, never opens SQLite, and never re-implements the
domain. This document states the **signature** of the shell (its
allowed subcommands, its environment contract, its artifacts) and the
**boundaries** it MUST respect.

## Surface

`hub` exposes the following subcommands. Each subcommand has a fixed
shape; subcommands not in this list are out of scope for v1.

```text
hub init        — create ~/.hub/ with state/, runtime/, logs/, tokens/
hub runtime     — up, down, status, logs, ps (Docker / Compose)
hub token       — show (redacted), rotate
hub open        — open Graph Explorer at 127.0.0.1:<loopback>
hub mcp         — launch --stdio (forwards to packages/mcp)
hub hub         — connect, preview, apply, rollback (over REST)
hub version     — print hub version, REST version, OpenAPI version
hub update      — pinned-channel upgrade (dry-run by default)
hub backup      — snapshot SQLite + config to a portable archive
hub doctor      — health + contract + secrets + policy check
```

Every subcommand has:

- A `--help` text that prints the contract, not the implementation.
- A `--json` flag for structured output.
- A deterministic exit code: `0` for success, `1` for operator error,
  `2` for fail-closed contract violation, `>=3` for unexpected
  failures.
- A redaction policy that strips `HUB_BEARER_TOKEN` and any bearer-shaped
  string from stdout, stderr, logs, and `--json` payloads.

## Environment contract

`hub` reads (only):

| Variable | Purpose |
|---|---|
| `HUB_HOME` | override `~/.hub/` location |
| `HUB_RUNTIME` | override the Compose project root |
| `HUB_OPENAPI` | override the path to `openapi/openapi.yaml` |
| `HUB_BEARER_TOKEN` | bearer used for REST calls (preferred over the file) |
| `HUB_BEARER_TOKEN_FILE` | path to the bearer file (`0600` required) |
| `HUB_BEARER_TOKEN_SOURCE` | `env` (default), `file`, or `cmd` (one-shot stdin) |
| `AGENT_MEMORY_TELEMETRY_LEVEL` | forwarded to the launcher |
| `TELEMETRY_ENABLED`, `TELEMETRY_LEVEL`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`, `TELEMETRY_SAMPLE_RATIO`, `TELEMETRY_EXPORT_INTERVAL_MS` | forwarded to the launcher |

`hub` MUST NOT write any of these variables. It MUST NOT inherit
secrets from a parent shell unless the operator passed them explicitly.

## Boundaries — what `hub` MUST NOT do

These are imported from `docs/product/product-boundaries.md` and
`docs/architecture/invariants.md`; restated here as Go-specific
constraints:

- **MUST NOT** open SQLite. `database/sql` against `hub.sqlite` is
  forbidden. The Go shell reads and writes the canonical state only
  through REST.
- **MUST NOT** import `HubDatabase`, `HubStorage`, `StorageRepository`,
  or any symbol that wraps a SQLite handle owned by `packages/storage-sqlite/`.
- **MUST NOT** reimplement MCP. The `hub mcp` command launches the
  TypeScript MCP process; it does not speak MCP itself.
- **MUST NOT** generate or copy the full OpenAPI SDK. The Go shell uses
  a thin, curated REST client under `internal/rest/` covering only the
  endpoints listed in the v1 command matrix (T0 contract).
- **MUST NOT** fork a long-running stateful process beyond the Graph
  UI static server. Every other long-running process is owned by
  Compose.
- **MUST NOT** read or write the bearer from anywhere except
  `HUB_BEARER_TOKEN`, `HUB_BEARER_TOKEN_FILE`, or a one-shot stdin
  prompt. The token file MUST be `0600`; the shell refuses to start
  otherwise.
- **MUST NOT** accept `--host 0.0.0.0` or `--public` flags. The shell
  refuses to start if those flags are present.
- **MUST NOT** route MCP through Go for v1. The Go shell launches the
  TypeScript MCP process; MCP does not call back into Go.

## Boundaries — what `hub` MUST do

- **MUST** call REST as a thin, versioned client. Every request carries
  the bearer and the W3C `traceparent` if present in the operator's
  session.
- **MUST** verify the version handshake before any stateful operation:
  `GET /api/v1/status` and `GET /api/v1/capabilities` agree with the
  Go shell's pinned matrix.
- **MUST** write its own logs to `HUB_HOME/logs/hub.log` with
  `0600`. Bearer-shaped strings MUST be redacted at write time.
- **MUST** produce deterministic `--json` output that does not include
  runtime secrets. The output is the contract surface for orchestrators.
- **MUST** heal transient subprocess failures with bounded backoff and
  surface a clear error to the operator when the bound is exceeded.
- **MUST** propagate the immutable runtime binding to REST calls; it
  MUST NOT silently change identity across calls.

## Version handshake

Before any stateful operation, `hub` MUST perform the version
handshake:

```text
hub version --json
{
  "hub":         "0.1.0",
  "rest":        "<version from GET /api/v1/status>",
  "openapi":     "<version from openapi.yaml info.version>",
  "go_version":  "<runtime build>",
  "node_version":"<runtime build>"
}
```

The matrix of accepted REST ↔ hub pairs is published in
`docs/phase0/handshake.md` (slice T0) and MUST be updated whenever the
Go shell's pinned matrix changes.

## Subprocess supervision

`hub runtime`, `hub open` and `hub mcp` are subprocess supervisors.
Supervision rules:

- **MUST** capture and forward subprocess exit codes without swallowing
  them.
- **MUST** apply a bounded restart budget (default: 3 restarts in 60 s
  before refusing to restart).
- **MUST** never buffer stderr silently. If stderr is large, it is
  truncated with a `(truncated)` marker and the full text is mirrored
  to the log file.
- **MUST** never log the bearer even when the subprocess does. A
  redaction filter is applied to the inherited environment of every
  subprocess.

## What the shell defers

- A built-in TUI. v1 uses plain `--help`, `--json`, and exit codes; a
  TUI is a separate slice.
- Hot reload. Configuration changes require a fresh `hub` process; the
  shell refuses `--reload`.
- Plugin loading. The shell has a fixed subcommand list; dynamic plugin
  discovery is not in v1.
- Network mode switching beyond `--lan-readonly`. Public exposure
  requires an ADR.
