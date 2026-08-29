# Versioned skill graph and mandatory retrieval

## Architecture

```text
                         User request
                              │
                              ▼
                      Retrieval Policy
                  deterministic classification
                              │
                    ┌─────────┴─────────┐
                    ▼                   ▼
            skills required      memory required
                    │                   │
                    └─────────┬─────────┘
                              ▼
                    Retrieval Resolver
                 ┌────────────┴────────────┐
                 ▼                         ▼
       lexical retrieval             personal context
       FTS5, no bodies               memory/profile APIs
                 │
                 ▼
       metadata/governance filter
                 │
                 ▼
       structural retrieval
       skill graph + snapshots
                 │
                 ▼
       deterministic lookup
       exact skill/version/resources
                 │
                 ▼
          Canonical context
                 │
                 ▼
               Agent
```

MCP stdio remains a thin adapter over local REST. REST and the domain hold the
classification, policy, validation, resolution, limits and audit. SQLite is the
only authority; a filesystem projection never changes canonical meaning.

The pipeline is explicit:

```text
DISCOVERY (FTS5, metadata-only)
  → SELECTION (scope/lifecycle + configurable ranking)
  → GRAPH EXPANSION (requires/extends)
  → VERSION RESOLUTION (immutable snapshot)
  → MATERIALIZATION (get_skill/read_skill_resource for selected skills only)
```

This is not chunk-based RAG. The contract distinguishes lexical retrieval,
structural retrieval and deterministic lookup. A future semantic backend or
reranker can propose candidates without changing identities, versions or the
REST contracts.

## Storage

The tables this contract reads and writes, introduced by migration `0016`.
This is not the full schema: later migrations add tables and columns that
retrieval does not touch.

```text
SQLite canonical
├── skills / skill_entries
├── skill_versions
├── skill_resources
├── skill_relations
├── retrieval_events
├── memories
├── profiles
├── provenance
├── audit
└── FTS5
```

`0016_skill_graph_retrieval.sql` is additive and transactional. It creates no
relations for historical skills. `skill_relations` references, by foreign key,
both the source version and the resolved target version. Its triggers reject
UPDATE and DELETE: a published relation is an immutable part of `skill@vN`.

## Relation model and semantics

| Type | Directed | Conceptually symmetric | Transitive | Dependency expansion | Acyclic |
|---|---:|---:|---:|---:|---:|
| `requires` | yes | no | yes | yes | yes |
| `uses` | yes | no | no | no | no |
| `extends` | yes | no | yes | yes | yes |
| `supersedes` | yes | no | yes | no | yes |
| `conflicts_with` | no | yes | no | no | no |
| `related_to` | no | yes | no | no | no |
| `produces` | yes | no | no | no | no |
| `consumes` | yes | no | no | no | no |

The types live in a domain registry rather than a closed SQL `CHECK`, so adding
one demands a code and documentation decision but not a destructive migration.
Each declaration is stored once; no automatic inverse row is created for
symmetric types.

All self-relations are disabled in the current registry. Duplicate
`(source version, type, target)` tuples are rejected. Every type marked
`acyclic` in the registry — currently `requires`, `extends` and `supersedes` —
rejects cycles over the governed heads. `related_to` and `conflicts_with` may
form cycles.

## Versions and reproducibility

Skills use immutable integer versions, not SemVer. The supported syntax is:

- exact: `4` or `=4`;
- minimum/maximum: `>=4`, `>4`, `<=7`, `<7`;
- conjunctive range: `>=2,<4`;
- compatible-lineage shorthand: `^3`, normalized to `>=3` for this integer
  sequence (it does not pretend SemVer majors exist);
- `head`, only for non-dependency relations whose semantics allow it.

At publication time every selector — `head` and ranges included — is resolved
and stored as `resolved_target_version`. That is why `skill@vN` always resolves
to the same versions even after the target publishes new heads. The original
expression is preserved for explanation, and doctor validates that the snapshot
satisfies it.

Changing relations uses full replacement with CAS and creates `vN+1` by copying
the body and resources. It never modifies a historical version. A single
resolution that reaches two different snapshots of the same skill returns a
stable `CONFLICT`.

## REST

Additive operations:

- `GET /api/v1/skills/{id}/relations?version=N`
- `PUT /api/v1/skills/{id}/relations` — full replacement: requires an `If-Match`
  header as the HTTP precondition and uses `body.expectedVersion` as the
  authoritative CAS value, creating a new immutable version
- `GET /api/v1/skills/{id}/dependents`
- `POST /api/v1/skills/resolve`
- `POST /api/v1/retrieval/resolve`

Reads are bound to the actor's scope. An out-of-scope target behaves as
`NOT_FOUND`; the graph does not reveal its metadata. The limits on candidates,
depth, nodes, body budget and thresholds are bounded and configurable within
domain maxima.

## MCP

Tools generated from OpenAPI:

- `get_skill_relations`
- `replace_skill_relations`
- `get_skill_dependents`
- `resolve_skill_graph`
- `resolve_retrieval`

`resolve_retrieval` documents that it must run before procedural, technical,
operational, configuration, deployment, debugging, migration or maintenance
work. Each harness wrapper only restates this rule and the no-match semantics;
it does not duplicate the classifier or the resolver.

## Mandatory retrieval

Initial categories:

- no mandatory skill retrieval: `conversational`, `general_knowledge`;
- mandatory skill retrieval: `procedural`, `operational`, `configuration`,
  `deployment`, `debugging`, `migration`, `maintenance`;
- mandatory memory/profile retrieval: `personal_context`.

A request can trigger both policies. In that case the resolver runs, in the same
decision, metadata-only FTS5 discovery over the scope's skills and memories, and
returns ids and versions from both for progressive retrieval. Mandatory
retrieval forces the search to happen; it does not force selecting weak results.
`canonicalThreshold` and `supportingThreshold` are bounded parameters with
documented defaults. A no-match is audited and lets the agent continue on
general knowledge without fabricating a skill or a memory.

The initial implementation uses a deterministic EN/ES lexical classifier and
FTS5 for metadata-only candidates. The score is computed over identity, name,
summary and tags; bodies are not loaded during discovery. If stopword filtering
removes every term, bounded raw tokens are used so that a mandatory policy never
skips discovery. Selected dependencies are included with a `dependency` reason,
plus parent, relation, depth, constraint and resolved version.

## Audit and privacy

Every resolution creates:

1. an append-only `retrieval_events` row with the actor, profile, the bounded and
   redacted query, the SHA-256 of the original query, the classification, the
   policy, the candidates, the selected skills and memories, the expansions and
   the no-match flag;
2. an entry in the general audit log, with no bodies and no secret values.

The bounded query redacts PEM blocks, Basic/Bearer authorization, JWTs, cookies,
API and AWS keys, client secrets, private keys, tokens and passwords before it is
persisted.

The model leaves room to later associate an `execution_id`, a profile version and
resource hashes without mutating historical tables.

## Import and export

The secondary projection always emits `skills/<name>/skill-relations.json`,
canonically from SQLite, even when `relations: []`. That makes the empty state
explicit and lets a rebuild remove stale relations. A preview contains only
relational metadata that has already passed limits, secret scanning and hashing —
never bodies or resource bytes.

The importer validates the explicit manifest, includes it in the digest, and
applies in two passes inside a single transaction: first every package, then the
relations remapped onto the imported snapshots. The declared constraint is kept
when the destination's versioning satisfies it; if a head-only export renumbers
versions so the constraint can no longer be satisfied, the imported snapshot is
pinned and the original expression is kept as provenance metadata. An empty
manifest clears relations; an absent manifest preserves historical ones. An
invalid target or a cycle reverts the whole apply. SQLite remains the authority
and the projection stays reproducible.

## Doctor

Added checks:

- `skillRelationsValid`
- `skillRelationTargetsExist`
- `skillDependencyGraphAcyclic`
- `skillVersionConstraintsValid`
- `skillGraphResolvable`
- `retrievalPolicyLoaded`
- `retrievalAuditHealthy`

A structural inconsistency marks doctor as unhealthy.
