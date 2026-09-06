# `@portable-agent-asset-hub/runtime-adapters`

Attaches the hub to five agent runtimes — **Codex, Claude Code, OpenCode,
Hermes, OpenClaw** — under one shared `preview → digest → apply → rollback`
contract. This is what lets the project claim "adding a sixth runtime means
writing a renderer, not another source of truth."

## What lives here

- **One folder per runtime** (`claude-code/`, `codex/`, `hermes/`,
  `openclaw/`, `opencode/`), each with:
  - `implementation.ts` — the runtime-specific rendering logic.
  - `paths.ts` — where that runtime expects its config/wrapper files.
  - `index.ts` — the public surface for that one adapter.
- **`registry.ts`** — maps a `HarnessId` to its adapter implementation, so
  callers select a runtime by id rather than importing each module by hand.
- **`apply.ts`** / **`preview.ts`** — the shared apply/preview pipeline
  every adapter plugs into (same shape as
  `@portable-agent-asset-hub/materializers`, but scoped to attaching a
  runtime rather than rendering skill content).
- **`contracts.ts`** — the shared types (`ApplyInput`, `ApplyResult`,
  `AdapterLogicalIds`, etc.) every adapter implementation returns.
- **`templates/wrapper.ts`** — the generated wrapper script template used
  by runtimes that need one to call back into the hub.
- **`internal/`** — safety primitives shared by every adapter:
  - `safe-mode.ts`, `safe-paths.ts`, `safe-target.ts` — path containment
    and file-mode checks so an adapter can never be tricked into writing
    outside its declared target directory.
  - `digest.ts` — the plan digest used to detect a stale apply.
  - `deep-readonly.ts` — a small `ReadonlyDeep<T>` type used to mark plan
    data as immutable end-to-end (kept local rather than pulling in a
    dependency for one utility).

## Public surface

External callers (`scripts/attach-agent-hub.mjs`, tests, future REST/MCP
wrappers) are expected to import only what `src/index.ts` re-exports.
Everything else under `src/` is internal and can change without notice —
`index.ts` documents that contract explicitly at the top of the file.

## Role in the system

A runtime adapter never reaches SQLite directly. It calls into
`@portable-agent-asset-hub/core` for domain data and produces a plan the
shared `computePreview` / `applyPlan` / `rollbackPlan` functions execute
against the filesystem, under the same containment and CAS guarantees as
the materializers package. See
[`../../docs/runtime-adapters.md`](../../docs/runtime-adapters.md) for the
full attach contract.

## Build

```sh
pnpm --filter @portable-agent-asset-hub/runtime-adapters build
```
