# Runtime adapters

`@portable-agent-asset-hub/runtime-adapters` configures an agent runtime to talk
to a local hub. It renders, previews, applies and rolls back the small set of
files a harness needs — a wrapper script, a descriptor, and the `USER.md` /
`SOUL.md` context files — under the same governed preview → digest → apply →
rollback lifecycle the materializers use.

Five harness families are supported, and `HarnessId` is a closed union:

| `HarnessId` | Descriptor rendered |
|---|---|
| `codex` | a TOML section |
| `claude-code` | `.mcp.json` MCP server entry |
| `opencode` | `opencode.json` MCP server entry |
| `hermes` | a command fragment |
| `openclaw` | a config fragment |

## Lifecycle

```text
computePreview(input)        pure projection, touches nothing
      │  → Preview { planDigest, files[] }
      ▼
operator reviews the digest
      ▼
applyPlan(input, reviewedDigest)   writes only on an exact digest match
      │  → ApplyResult { runId, written[] }
      ▼
rollbackPlan(input, runId)         restores the pre-apply bytes
```

`computePreview` is a pure function over its inputs: it never reads or writes the
target directory. `applyPlan` writes only when the caller passes a
`reviewedDigest` that matches the preview and every input still validates. That
is the same contract the hub applies to materializations, so an operator reviews
a plan digest rather than trusting a tool to do the right thing.

## Invariants

These are asserted by `tests/runtime-adapters/runtime-adapters.test.ts`:

- **Path containment.** Every `PlanFile.relativePath` is forward-slash, has no
  leading slash, no `..` segment and no empty segment, and contains no symlink
  anywhere along its path. The apply pipeline rejects any path that escapes
  `targetRoot`, and rejects a `targetRoot` that is itself a symlink
  (`SafePathError`, `SafeTargetError`).
- **Context files are opaque.** `USER.md` and `SOUL.md` are copied byte for byte.
  The renderer never logs, prints or echoes their contents — the preview JSON
  carries only `sha256` and `size`, never the body.
- **No secrets cross the boundary.** Descriptor generators emit
  environment-only configuration (REST URL, capabilities) and no bearer tokens.
  The harness-side bin shims resolve the token from their own environment; see
  `--auth-token-file` in the README.
- **No native roots are read.** The adapter never inspects `~/.codex`,
  `~/.claude`, or any other historical harness path. Every input arrives as an
  explicit CLI argument.
- **Safe file modes.** `assertSafeMode` refuses any mode carrying setuid, setgid
  or sticky bits; the defaults are `0644` for data and `0755` for the wrapper.

## Public surface

`src/index.ts` is a curated export list — everything under `src/internal/` and
each `src/<harness>/implementation.ts` is private and may change without notice.
The contract is:

- `computePreview`, `applyPlan`, `rollbackPlan`, `deriveRunId`, `readRegistry`
- `RENDERERS`, `getRenderer`, `listRenderers`, `HARNESS_IDS`
- per-harness renderers, relative path constants, and the
  `serialise*` / `parse*` pair for each descriptor format
- the contract types (`Preview`, `PlanDigest`, `PlanFile`, `ApplyInput`,
  `ApplyResult`, `RollbackInput`, `RollbackResult`, `Renderer`, …)

## Attaching a hub

`scripts/attach-agent-hub.mjs` is the supported entry point. It wraps the same
preview → digest → apply → rollback flow:

```sh
pnpm hub:attach -- --harness opencode --target-dir /absolute/project \
  --profile default --user-file /absolute/USER.md --soul-file /absolute/SOUL.md \
  --rest-url http://127.0.0.1:39421 --mcp-entry /absolute/path/to/mcp-entry \
  --agent-id main --auth-token-file /absolute/0600/token
```

Harness-specific registration stays encapsulated in the five renderers. The core
has no dependency on Codex, Claude Code, OpenCode, Hermes or OpenClaw.

## Related documentation

- [`architecture.md`](architecture.md) — where adapters sit in the system
- [`canonical-storage.md`](canonical-storage.md) — storage mode resolution
- the README's *Runtime identity and capability handshake* section — how
  `--auth-token-file` and bearer mode work
