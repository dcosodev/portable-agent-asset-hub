# `@portable-agent-asset-hub/skill-export`

Deterministic export of skills — either a single "focal" skill plus its
dependency closure, or the full canonical set — into a portable file
layout with a manifest of relations.

## What lives here

- **`exporter.ts`** (`SkillExportCoordinator`) — orchestrates an export:
  preview is metadata-only (no body/resource bytes leave the process until
  apply), and apply writes to a staging directory on the same filesystem
  as the target before promoting the result via an atomic rename. A failed
  apply can always be replayed rather than leaving a half-written export.
- **`digest.ts`** — computes the deterministic digest an export is
  verified against.
- **`validator.ts`** — validates an export request/result against the
  contract (size limits, allowed paths, etc.), reusing the same posture as
  `core`'s skill validation.
- **`types.ts`** — the request/response shapes for focal vs. full export.

## Relation manifests are canonical, proposals are not

Every export emits `skills/<name>/skill-relations.json` from SQLite —
even an empty `relations: []` — so a rebuild can tell "no relations" apart
from "not exported yet." **Relation proposals are staging data and are
never included** in an export; only relations that went through governed
review (see [`../../docs/skill-relations.md`](../../docs/skill-relations.md))
are canonical enough to export.

## Build

```sh
pnpm --filter @portable-agent-asset-hub/skill-export build
```
