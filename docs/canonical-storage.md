# Canonical hub storage

## Canonical database

On macOS the default persistent database is:

```text
~/Library/Application Support/portable-agent-asset-hub/hub.sqlite
```

On other platforms the default is:

```text
$XDG_DATA_HOME/portable-agent-asset-hub/hub.sqlite
```

or, when `XDG_DATA_HOME` is unset:

```text
~/.local/share/portable-agent-asset-hub/hub.sqlite
```

The resolver is centralized in `packages/core/src/storage/config.ts` as `resolveHubDatabasePath()`.

## Precedence

```text
1. --db <path> on agent-memory-rest
2. AGENT_MEMORY_DB_PATH
3. AGENT_MEMORY_DATA_DIR or PORTABLE_AGENT_ASSET_HUB_DATA_DIR + hub.sqlite
4. platform persistent default
```

The REST launcher emits a `HUB_STORAGE` diagnostic and `AGENT_MEMORY_READY` with the resolved path. The API reports storage mode and source in `/api/v1/status` and `/api/v1/capabilities`. Exact paths are returned only in local-dev status/capabilities; bearer-facing responses expose `databaseName` and mode/source.

## Storage modes

The resolver returns:

```text
canonical
temporary
test
```

An explicit path under the OS temp directory, `/tmp`, `/var/tmp`, or test/E2E/fixture path is marked temporary unless an explicit `test` mode is selected. A canonical mode cannot use a temporary path. Temporary databases remain supported for tests and E2E.

This is configuration-derived. The system does not infer canonical status merely because a path is outside `/tmp`.

## Launching

Canonical runtime, using the default persistent path:

```sh
pnpm hub:start
```

Equivalent direct REST invocation:

```sh
pnpm --filter @portable-agent-asset-hub/rest rest-entry --storage-mode canonical
```

Canonical override:

```sh
pnpm --filter @portable-agent-asset-hub/rest rest-entry --db /absolute/persistent/path/hub.sqlite --storage-mode canonical
```

Temporary runtime for development/E2E:

```sh
pnpm hub:start:temp
```

An explicit temporary DB can be supplied with `AGENT_MEMORY_DB_PATH`; it is reported as `temporary` and `explicit-env`.

## Initialization

A new canonical database must be initialized through the normal productive flow:

1. start or open the canonical runtime, which creates the parent directory and runs migrations;
2. inventory the configured skill roots with `scripts/inventory-agent-skills.mjs`;
3. preview and apply `scripts/import-agent-skills.mjs` against the canonical DB;
4. verify schema, skill heads, resources, relations, proposals, integrity, and doctor.

Temporary databases must not be copied into the canonical location. Relation proposals and canonical relation rows are not imported automatically from temporary discovery/E2E databases.

## Canonical write guard

Relation apply is a canonical mutation. The server-side resolver rejects it before storage whenever the runtime mode is temporary, regardless of client headers:

```text
Canonical write refused: runtime is using temporary storage
```

`X-Agent-Operation-Mode: canonical` may be sent as an explicit client signal, but it is not the authority. Temporary runtimes may still execute apply-preview for E2E validation; they cannot execute the final relation apply endpoint.

## Backup

Use the SQLite online backup command rather than copying an active database:

```sh
pnpm hub:backup -- --db "$HOME/Library/Application Support/portable-agent-asset-hub/hub.sqlite" --output /secure/backup/path/hub-$(date +%Y%m%d-%H%M%S).sqlite
```

The helper delegates to SQLite `.backup`, creates the destination parent with mode `0700`, and does not mutate the source.

## Diagnostics

```sh
curl -fsS http://127.0.0.1:39421/api/v1/status
curl -fsS http://127.0.0.1:39421/api/v1/capabilities
curl -fsS http://127.0.0.1:39421/api/v1/admin/doctor
sqlite3 "$HOME/Library/Application Support/portable-agent-asset-hub/hub.sqlite" 'PRAGMA integrity_check; PRAGMA foreign_key_check;'
```

The Graph Explorer footer shows `DB canonical`, `DB temporary`, or `DB test`, together with schema, auth, skill, and relation counts.

## Current initialization decision

The previous active databases `/tmp/pah-manual-batch/source.sqlite` and `/tmp/pah-graph-e2e.sqlite` are temporary and are not canonical sources. This storage contract intentionally does not copy either one. The canonical database must be initialized from the current skill roots through the official inventory/import flow, with zero relation proposals and zero canonical relations unless a separately verified persistent source already exists.
