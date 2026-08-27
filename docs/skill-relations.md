# Skill relations

This is the single current relation-model document. Historical run reports may describe decisions at the time, but they must link here instead of redefining the model.

## Authority

- SQLite is the canonical hub authority.
- `skill_relations` is the canonical applied graph.
- `SKILL.md` and frontmatter are not relation authority.
- `metadata.hermes.related_skills` is structured evidence. It creates an `ExplicitRelationCandidate`; it never canonicalizes automatically.
- Discovery/FTS produces suggestions. It does not decide canonical truth.

## Relation types

`related_to` is symmetric for graph/equivalence semantics. Other relation types remain directional according to their domain meaning. Identity and equivalence are centralized in `normalizeRelationIdentity`, `isRelationEquivalent` and `isSymmetricRelationType` in `packages/core/src/skills/relation-identity.ts`.

## Proposals and lifecycle

`skill_relation_proposals` is staging/review state. It stores discovered or manual origin, detector/evidence, suggested values, reviewed values, lifecycle and provenance. A proposal is not a canonical edge.

```text
candidate source
  -> proposal (suggested values)
  -> review / approve
  -> apply-preview
  -> planDigest
  -> governed apply
  -> skill_relations
```

Canonical-equivalent proposals become `superseded`; they are not inserted directly into `skill_relations`. Apply requires the reviewed digest and server-side canonical storage mode.

## Explicit metadata workflow

The extractor reads only the current head's structured `metadata.hermes.related_skills`, resolving tokens by canonical logical key. It exposes:

- `READY_FOR_REVIEW`
- `ALREADY_STAGED`
- `ALREADY_CANONICAL`
- `UNRESOLVED`
- `AMBIGUOUS`

Reciprocity is an evidence flag, not confidence. A reciprocal candidate has declarations in both heads; a one-way candidate has only the source declaration. Staging remains a human action and uses the proposal lifecycle.

REST endpoints:

- `GET /api/v1/skill-relation-candidates/explicit`
- `POST /api/v1/skill-relation-candidates/explicit/impact`
- `POST /api/v1/skill-relation-candidates/explicit/stage`

Graph Explorer provides the Explicit Relations queue, status/direction filters, candidate inspector, explicit metadata layer toggle, Stage selected and read-only impact preview. Canonical apply is still performed only through the reviewed proposal apply flow.

## Discovery

Relation Discovery and FTS are review aids. Confidence or classifier output never authorizes canonicalization and never replaces review. No discovery batch is part of the explicit metadata workflow.

## Graph semantics

Graph Explorer renders three conceptual layers:

- canonical: solid applied edges from `skill_relations`;
- proposals: review/staging edges from `skill_relation_proposals`;
- explicit metadata: ghost evidence edges, not canonical truth.

Impact preview compares the full current canonical graph over all active skill heads with the same graph plus selected READY candidates. It reports nodes indirectly through the full-head population and reports edges, components, isolated nodes and largest component. It is read-only and is not the apply preview.

## Portability

Official export/import transports canonical relations with manifests. Proposal staging is not exported as canonical graph data. See [`canonical-storage.md`](canonical-storage.md) and [`architecture.md`](architecture.md).
