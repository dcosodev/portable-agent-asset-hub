# Slices

A **slice** is an isolated, time-boxed exploration ("spike") used to answer
a specific go/no-go question before committing the main workspace to a
design. Slices live outside the pnpm workspace on purpose: they have their
own `package.json`, lockstep tooling, and tests, they are not compiled or
shipped with the published packages, and they are throwaway by default —
kept only when their outcome documents a decision.

## `1-spike-skills`

This spike answered one question: **should the hub extract runtime code
from the upstream `TencentCloud/TencentDB-Agent-Memory` project (MIT), or
implement a clean-room, contract-informed design of its own?**

- **Verdict** (see [`1-spike-skills/go-no-go.md`](1-spike-skills/go-no-go.md)):
  direct code extraction was rejected, and a clean-room implementation informed
  by the upstream contract shapes was approved. The decision and its consequences are recorded in
  [ADR 0003](../docs/adr/0003-tencent-extraction-boundary.md).
- **Provenance:** the reviewed upstream file set, pinned to commit
  `97f94654280b2932c35ba4806a491999ed244cc9`, is recorded in
  [`1-spike-skills/reuse-report.json`](1-spike-skills/reuse-report.json)
  and in [`docs/upstream-reuse.yaml`](../docs/upstream-reuse.yaml).
- **Contents:** a minimal skills-surface prototype (SQLite store, MCP
  stdio server, REST/MCP parity tests, security tests) with its own gate
  scripts, a small version of the method described in
  [`docs/archive/engineering-log.md`](../docs/archive/engineering-log.md).

## Evidence note

The gate scripts in a slice write their evidence under the repository's
`artifacts/` directory, which is generated locally and Git-ignored —
evidence files referenced from slice documents (e.g.
`artifacts/s1-evidence.json`) are **not** part of the public export.
Re-running the slice's gate regenerates them; the durable outcome is the
committed go/no-go record and reuse report, not the transient evidence.
