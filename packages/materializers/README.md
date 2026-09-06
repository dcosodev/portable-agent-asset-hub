# `@portable-agent-asset-hub/materializers`

Renders canonical hub state (skills, resources, relations) into a target
runtime's own file layout, and safely undoes that render. This is the
`preview → apply → rollback` engine for **Hermes** and **OpenClaw**.

## What lives here

- **`preview.ts`** — computes a diff/digest of what an `apply` would do,
  without touching disk.
- **`apply.ts`** — writes the materialized files, guarded by the digest
  from `preview` (a stale digest is refused rather than silently applied
  over newer state).
- **`rollback.ts`** — undoes exactly what a given run applied. Files that
  the apply added over a previously-empty target are tracked with
  `.deleted` markers so rollback (and the failure path) can remove them
  correctly — files an apply overwrote are restored, not just deleted.
- **`registry.ts`** — an in-memory map from a completed `applyPlan`'s
  `runId` to the filesystem coordinates it touched, so `rollbackPlan` does
  not need to scan the user's `HOME` to find them.
- **`locks.ts`** — a CAS-based lock per run so concurrent applies against
  the same target don't interleave.
- **`manifest.ts`** / **`manifest.v1.json`** — the versioned manifest
  schema written alongside every apply, recording what was written and
  with what plan digest.
- **`hermes/`**, **`openclaw/`** — one adapter per renderer (`adapter.ts`,
  `manifest.ts`, `paths.ts`, and for OpenClaw a `plugin-manifest.ts` and
  `config.ts`). Adding a new materializer target means adding a folder
  here with the same shape, not touching `apply.ts`/`preview.ts`/`rollback.ts`.

## Role in the system

This is *not* the same thing as `@portable-agent-asset-hub/runtime-adapters`.
`runtime-adapters` attaches a hub to a coding agent runtime (Codex, Claude
Code, OpenCode, plus Hermes and OpenClaw) so that runtime can *call* the
hub. `materializers` renders hub-owned assets *into* Hermes' and OpenClaw's
own config/skill file formats. Both packages share the same
`preview → apply → rollback` shape and the same safety posture (path
containment, CAS-guarded applies, exact rollback) but operate on different
targets.

## Build

```sh
pnpm --filter @portable-agent-asset-hub/materializers build
```
