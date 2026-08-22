# ADR 0003: Tencent extraction boundary

- **Status:** Accepted
- **Date:** 2026-08 (public export)

## Context

The upstream project `TencentCloud/TencentDB-Agent-Memory` (MIT licensed)
was reviewed as prior art during the S1 spike. Copying runtime modules
from it wholesale would have created two problems:

1. **Provenance ambiguity.** Mixed-origin source files make it hard to
   state, per file, what is original work and what is derived, which the
   public-surface policy (gate S0) requires.
2. **Architecture drag.** The upstream design is coupled to Tencent cloud
   services (vector database, object storage), which
   [ADR 0002](0002-portable-v1-exclusions.md) excludes from portable v1.

The S1 go/no-go review (see
[`slices/1-spike-skills/go-no-go.md`](../../slices/1-spike-skills/go-no-go.md))
concluded **GO_WITH_PIVOT**: direct code extraction was rejected
(**NO-GO**), while proceeding to a clean-room, contract-informed
implementation was approved (**GO**).

## Decision

- Upstream reuse is **selective and pinned** to commit
  `97f94654280b2932c35ba4806a491999ed244cc9`, recorded in
  [`docs/upstream-reuse.yaml`](../upstream-reuse.yaml) with status
  `pinned-read-only`.
- **No Tencent runtime module is copied** into this repository. The
  implementation is clean-room: informed by the upstream contract shapes,
  written independently. The reviewed upstream file set is recorded in
  [`slices/1-spike-skills/reuse-report.json`](../../slices/1-spike-skills/reuse-report.json).
- Any future reuse entry must record the upstream commit, license, and
  treatment before code lands (`policy.require_commit_license_treatment`
  in `upstream-reuse.yaml`); `MemoryProxy/`, `MemoryPanel/`, and Tencent
  cloud services are excluded outright.
- Attribution is carried regardless: the MIT license text is preserved
  under `third_party/licenses/TENCENTDB_AGENT_MEMORY_LICENSE`, referenced
  from [`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md), and the
  repository-root [`NOTICE`](../../NOTICE) file states the upstream
  attribution.

## Consequences

- Every file in the shipped packages is original work with a single,
  stated provenance; the reuse manifest (`reuse_entries: []`) is honest
  about the fact that, to date, no upstream code has been copied.
- The upstream review effort is still documented and auditable (pinned
  commit, reviewed file list, go/no-go record) rather than discarded.
- Future contributors have a mechanical rule to follow: no upstream code
  without a manifest entry that names commit, license, and treatment.
