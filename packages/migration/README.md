# `@portable-agent-asset-hub/migration`

The migration / cutover surface: moving data from an external or legacy
source into the hub's canonical storage, safely.

## What lives here

- **`source.ts`** — reads from the external/legacy source.
- **`classifier.ts`** — classifies incoming records (what kind of asset,
  what target shape) before they're imported.
- **`redactor.ts`** — strips secrets/sensitive values from records during
  migration, reusing the same posture as `core`'s importer secret scan.
- **`exporter.ts`** / **`importer.ts`** — export from the hub / import into
  it, the two directions a migration can run.
- **`shadow.ts`** — runs the new path in parallel with the old one without
  cutting over, so behavior can be compared before committing.
- **`replay.ts`** — replays recorded events/operations against the target,
  used both for migration and for the S10 gate's replay checks.
- **`cutover.ts`** — the actual switch from old source to new, once shadow
  validation is satisfied.
- **`rollback.ts`** — undoes a cutover.
- **`retirement.ts`** — the final step: decommissioning the old source once
  cutover is confirmed stable.
- **`state-machine.ts`** — the state machine tying the above phases
  together so a migration can't skip a step or retire a source it never
  actually cut over.
- **`storage.ts`** / **`storage-adapter.ts`** — persistence for the
  migration process's own bookkeeping (separate from the domain data being
  migrated).
- **`adapters/python.ts`** — an adapter for a Python-based source.

## Role in the system

This package operates on the same `core` domain types and the same storage
adapters as the rest of the hub — it is not a one-off script, it's a
first-class surface with its own gate (S10; see the root
[`README.md`](../../README.md#staged-gates-s0s10)) covering migration
safety, replay, and retirement.

## Build

```sh
pnpm --filter @portable-agent-asset-hub/migration build
```
