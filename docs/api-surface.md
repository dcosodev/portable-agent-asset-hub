# API surface

The contract is [`openapi/openapi.yaml`](../openapi/openapi.yaml), OpenAPI 3.1. The file is
JSON-formatted, which is valid YAML; its path is pinned by the drift detector and
by each generated SDK's `PROVENANCE.json`, so it keeps the `.yaml` name. If this
table and the contract disagree, the contract is right.

The contract defines 51 operations, 27 of which are exposed as MCP tools. The rest
are REST-only: the graph and retrieval-explorer reads, the relation-proposal
workflow, and some writes such as `createBinding`, catalog sync and materialization
preview and rollback.

## Columns

- **Safety** comes from `x-mcp.safety`: `safe`, `mutating`, `destructive` or
  `diagnostic`.
- **CAS** means `x-cas-required: true`. The REST server answers
  `428 PRECONDITION_REQUIRED` if the request has no `If-Match` header.
- **Idempotent** mirrors `x-idempotent`: the operation is safe to retry under the
  core's idempotency tracking.
- **MCP tool** reflects `x-mcp.exposed`.

## Operations

| Method | Path | operationId | MCP capability | Safety | CAS | Idempotent | MCP tool |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/v1/health` | `getHealth` | `health.read` | safe | — | — | yes |
| GET | `/api/v1/status` | `getStatus` | `status.read` | safe | — | — | yes |
| GET | `/api/v1/capabilities` | `getCapabilities` | `capabilities.read` | safe | — | — | yes |
| GET | `/api/v1/admin/doctor` | `getDoctor` | `admin.doctor` | diagnostic | — | — | yes |
| GET | `/api/v1/identities` | `listIdentities` | `identity.read` | safe | — | — | yes |
| POST | `/api/v1/bindings` | `createBinding` | `binding.write` | mutating | yes | yes | no |
| POST | `/api/v1/profiles` | `createProfile` | `profile.write` | mutating | — | yes | yes |
| GET | `/api/v1/memory-blocks` | `listMemoryBlocks` | `memory.read` | safe | — | — | yes |
| POST | `/api/v1/events` | `createEvent` | `event.write` | mutating | — | yes | no |
| GET | `/api/v1/memories/search` | `searchMemories` | `memory.read` | safe | — | — | yes |
| GET | `/api/v1/memories/{id}` | `getMemory` | `memory.read` | safe | — | — | yes |
| POST | `/api/v1/memories` | `createMemory` | `memory.write` | mutating | — | yes | yes |
| POST | `/api/v1/memories/{id}/supersede` | `supersedeMemory` | `memory.supersede` | mutating | yes | yes | yes |
| POST | `/api/v1/memories/{id}/forget` | `forgetMemory` | `memory.forget` | destructive | yes | yes | yes |
| GET | `/api/v1/skills/search` | `searchSkills` | `skill.read` | safe | — | — | yes |
| GET | `/api/v1/skills/{id}` | `getSkill` | `skill.read` | safe | — | — | yes |
| GET | `/api/v1/skills/{id}/resources` | `listSkillResources` | `skill.resource.read` | safe | — | — | yes |
| GET | `/api/v1/skills/{id}/resources/{resourcePath}` | `readSkillResource` | `skill.resource.read` | safe | — | — | yes |
| GET | `/api/v1/resources/{path}` | `getResource` | `resource.read` | safe | — | — | yes |
| GET | `/api/v1/catalog/search` | `searchCatalog` | `catalog.read` | safe | — | — | yes |
| GET | `/api/v1/catalog` | `getCatalog` | `catalog.read` | safe | — | — | yes |
| POST | `/api/v1/catalog/sync/preview` | `previewCatalogSync` | `catalog.sync.preview` | mutating | — | yes | no |
| POST | `/api/v1/catalog/sync/apply` | `applyCatalogSync` | `catalog.sync.apply` | mutating | yes | yes | no |
| GET | `/api/v1/audit` | `listAudit` | `audit.read` | safe | — | — | yes |
| GET | `/api/v1/snapshots` | `listSnapshots` | `snapshot.read` | safe | — | — | yes |
| POST | `/api/v1/replay` | `replay` | `replay.run` | diagnostic | — | yes | no |
| POST | `/api/v1/materializations/preview` | `previewMaterialization` | `materialization.preview` | safe | — | yes | no |
| POST | `/api/v1/materializations/apply` | `applyMaterialization` | `materialization.apply` | mutating | yes | yes | yes |
| POST | `/api/v1/materializations/{run_id}/rollback` | `rollbackMaterialization` | `materialization.rollback` | destructive | yes | yes | no |
| GET | `/api/v1/skills/{id}/relations` | `getSkillRelations` | `skill.read` | safe | — | — | yes |
| PUT | `/api/v1/skills/{id}/relations` | `replaceSkillRelations` | `write.skill` | mutating | yes | yes | yes |
| GET | `/api/v1/skills/{id}/dependents` | `getSkillDependents` | `skill.read` | safe | — | — | yes |
| POST | `/api/v1/skills/resolve` | `resolveSkillGraph` | `skill.read` | safe | — | — | yes |
| POST | `/api/v1/retrieval/resolve` | `resolveRetrieval` | `skill.read` | safe | — | — | yes |
| GET | `/api/v1/graph/skills` | `getGlobalSkillGraph` | `skill.read` | safe | — | yes | no |
| GET | `/api/v1/skills/{id}/graph` | `getSkillGraph` | `skill.read` | safe | — | yes | no |
| GET | `/api/v1/skills/{id}/impact` | `getSkillImpact` | `skill.read` | safe | — | yes | no |
| GET | `/api/v1/retrieval-events` | `listRetrievalEvents` | `skill.read` | safe | — | yes | no |
| GET | `/api/v1/retrieval-events/{id}/graph` | `getRetrievalEventGraph` | `skill.read` | safe | — | yes | no |
| GET | `/api/v1/skill-relation-proposals` | `listSkillRelationProposals` | `skill.relation.proposal.read` | safe | — | — | no |
| POST | `/api/v1/skill-relation-proposals` | `createManualSkillRelationProposal` | `skill.relation.proposal.create` | mutating | yes | yes | no |
| GET | `/api/v1/skill-relation-proposals/{id}` | `getSkillRelationProposal` | `skill.relation.proposal.read` | safe | — | — | no |
| POST | `/api/v1/skill-relation-proposals/discover` | `discoverSkillRelationProposals` | `skill.relation.proposal.create` | safe | — | — | no |
| POST | `/api/v1/skill-relation-proposals/{id}/approve` | `approveSkillRelationProposal` | `skill.relation.proposal.review` | mutating | yes | — | no |
| POST | `/api/v1/skill-relation-proposals/{id}/reject` | `rejectSkillRelationProposal` | `skill.relation.proposal.review` | mutating | yes | — | no |
| POST | `/api/v1/skill-relation-proposals/apply-preview` | `previewSkillRelationProposalApply` | `skill.relation.proposal.apply` | safe | — | — | no |
| POST | `/api/v1/skill-relation-proposals/reconcile-canonical-duplicates` | `reconcileSkillRelationProposalDuplicates` | `skill.relation.proposal.reconcile` | mutating | yes | yes | no |
| POST | `/api/v1/skill-relation-proposals/apply` | `applySkillRelationProposals` | `skill.relation.proposal.apply` | mutating | yes | — | no |
| GET | `/api/v1/skill-relation-candidates/explicit` | `listExplicitSkillRelationCandidates` | `skill.relation.candidate.read` | safe | — | yes | no |
| POST | `/api/v1/skill-relation-candidates/explicit/impact` | `previewExplicitSkillRelationCandidatesImpact` | `skill.relation.candidate.read` | safe | — | yes | no |
| POST | `/api/v1/skill-relation-candidates/explicit/stage` | `stageExplicitSkillRelationCandidates` | `skill.relation.candidate.stage` | mutating | yes | yes | no |

## Removed in 0.2.0

`listSkills` (`GET /api/v1/skills`) and `listSkillVersions`
(`GET /api/v1/skills/{id}/versions`) were removed. The canonical skill read surface
is `searchSkills`, `getSkill`, `listSkillResources` and `readSkillResource`. The MCP
tools `list_skills` and `list_skill_versions` went with them, so a client that
hardcodes those names fails at tool discovery. See
[`CHANGELOG.md`](../CHANGELOG.md).
