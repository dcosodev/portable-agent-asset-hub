# The `hub` CLI

`hub` is a Go CLI for operating a local hub. It has no external Go dependencies, holds
no domain state and does not reimplement domain logic. Go code never opens SQLite.
`hub backup` and `hub hub connect` delegate to Node child processes shipped under
`internal/`, which use the TypeScript packages.

## Building

```sh
go build -o cmd/hub/hub ./cmd/hub
```

`hub` derives its default `HUB_OPENAPI` path from the binary's location, so build to
this path or set `HUB_OPENAPI`. The binary is not Git-ignored; do not commit it.

## Commands

```text
hub version       print the version; --json for the structured form
hub path <key>    print a resolved path (home, runtime, openapi, log, token)
hub config <key>  print a config value; --json for all
hub init          create the HUB_HOME layout and a bearer token (idempotent)
hub token         show (redacted), rotate
hub runtime       Docker Compose stack: up, down, status, logs, ps
hub telemetry     optional observability profile: up, down, status
hub open          serve the embedded Graph Explorer on loopback only
hub mcp           launch --stdio: supervise the TypeScript MCP process
hub hub connect   preview, apply, rollback against a runtime target
hub backup        --out <archive> snapshots, --restore <archive> restores
hub update        plan only; --apply is refused with exit 2
hub doctor        read-only health, contract and policy check; --json
```

`hub --help` and each command's `--help` print the full surface. An unknown command
or key exits with 2.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success. |
| `1` | Operator or runtime error, such as Node missing or an adapter failure. |
| `2` | Contract violation, such as a bad flag or an unknown key. |

## Output

Output goes through `internal/output`:

- stdout carries the human-readable result, the `--json` payload and `--help` text;
- stderr carries diagnostics, warnings and errors;
- when `$CI` is set, there are no interactive prompts or ANSI colours;
- bearer-shaped strings are replaced with `<<REDACTED>>`.

## Files

`hub init` creates this layout under `HUB_HOME`, which has an XDG-style default:

```text
state/
runtime/
logs/      hub.log
tokens/    hub.token (mode 0600)
```

Token writes are atomic and use mode `0600`.

## Environment

| Variable | Purpose |
|---|---|
| `HUB_HOME` | Override the home directory. |
| `HUB_RUNTIME` | Override the Compose project root. |
| `HUB_OPENAPI` | Override the path to `openapi/openapi.yaml`. |
| `HUB_OPEN_BIND`, `HUB_OPEN_PORT` | Bind address and port for `hub open`. Non-loopback addresses are refused. |
| `HUB_MCP_COMMAND` | Override the command `hub mcp` launches. |
| `HUB_NODE_BIN` | Override the Node binary used for child processes. Must be absolute. |
| `HUB_ALLOW_HUB_DATA_REMOVAL` | Set to `1` to let the Compose service remove the `hub-data` volume. Intended for tests. |

`HUB_BEARER_TOKEN`, `HUB_BEARER_TOKEN_FILE` and `HUB_BEARER_TOKEN_SOURCE` are stripped
from the environment of the Compose, connect and backup child processes. The Compose
layer can forward a token file through `HUB_BEARER_TOKEN_FILE` when asked to.

## Rules

Code comments use these labels for two rules:

- **I-07, bearer hygiene.** Output is redacted, and child processes do not inherit a
  bearer.
- **I-10, loopback first.** `hub open` and `--health-url` refuse non-loopback targets.

`hub` also does not reimplement MCP: `hub mcp launch --stdio` supervises the TypeScript
process and restarts it with bounded backoff, up to five attempts.

## Version output

`hub version --json` prints keys in alphabetical order:

```json
{"go":"go1.24.3","hub":"0.1.0","openapi":"unknown","rest":"unknown","service":"hub"}
```

`rest` and `openapi` are `unknown` until they are wired in. Orchestrators should parse
this object, not the human-readable line.

## Designed but not implemented

The original design for the shell included the following, which the code does not do:

- a version handshake against `GET /api/v1/status` and `GET /api/v1/capabilities`
  before stateful operations, with a matrix of accepted versions;
- REST calls from the commands: `internal/rest` is a thin client that the commands do
  not use, so W3C `traceparent` and runtime-binding propagation do not exist either;
- writing shell logs to `HUB_HOME/logs/hub.log`: the path is reserved;
- forwarding telemetry variables to the launcher from `hub` itself;
- an applying `hub update`;
- a `--lan-readonly` network mode.

Deliberately left out: a TUI, hot reload, and plugin loading. Public exposure would
need an ADR.
