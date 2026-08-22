# ADR 0002: Portable v1 exclusions

- **Status:** Accepted
- **Date:** 2026-08 (public export)

## Context

The hub's scope was informed by a broader agent-memory ecosystem that
includes cloud-hosted services and runtime-integrated capture components.
The portable v1 contract has a different goal: a **local-first,
reproducible, auditable** hub that anyone can build and validate on a
single machine with no external accounts, credentials, or hosted
dependencies. Carrying cloud-coupled features into v1 would break that
property and force the fail-closed gates to depend on services they cannot
control.

## Decision

Portable v1 explicitly excludes:

- **Cloud services** (including the Tencent-hosted vector-database and
  object-storage backends present in the upstream prior art; see
  [ADR 0003](0003-tencent-extraction-boundary.md)). All storage in v1 is
  local: SQLite (single owner per [ADR 0001](0001-single-sqlite-owner.md))
  and the filesystem adapter.
- **Memory Proxy / Memory Panel** style runtime components — long-running
  intermediaries that sit between an agent runtime and its model provider.
  V1 is a hub with explicit request/response surfaces (REST, MCP, SDKs),
  not an interception layer.
- **LLM capture** — automatic harvesting of conversation content into
  memories. V1 memories are created only through explicit, audited write
  operations (`createMemory`, `supersedeMemory`, `forgetMemory`).
- **Harness mutation** — v1 never rewrites an agent runtime's own
  configuration in place outside the materializer contract. Runtime
  changes go through versioned materializations with `preview`, `apply`,
  and `rollback`, guarded by CAS locks.

The S1 exploration that tested these boundaries lives as an isolated spike
under [`slices/1-spike-skills/`](../../slices/README.md); it is not part of
the pnpm workspace and is not compiled or shipped with the packages.

## Consequences

- The entire validation story (gates S0–S10) runs locally and fail-closed,
  with no network or account prerequisites beyond package installation and
  the pinned SDK generator toolchain.
- Features that inherently require a hosted component are out of contract
  for v1 and would need a new ADR (and likely a major contract revision)
  to enter.
- A private deployment that wants runtime capture or proxying must build
  it as an external adapter on top of the hub's public surfaces, keeping
  the hub itself portable.
