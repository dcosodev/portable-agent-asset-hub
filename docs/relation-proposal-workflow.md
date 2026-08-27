# Relation Proposal Workflow

Canonical relations live only in SQLite (`skill_relations`). `SKILL.md`,
frontmatter, tags and `related_skills` are discovery signals, never relation
authority. `skill-relations.json` is the portable representation of the graph
that has already been applied.

## Governed flow

1. Bounded discovery (`strict`, `balanced`, `exploratory`) produces pairs and
   proposals in `skill_relation_proposals`.
2. A proposal carries `candidateScore` (how relevant the pair is), `confidence`
   (how much we trust the suggestion), the detector, the version, the evidence
   and the origin (`discovered` / `manual`). No confidence value authorizes
   canonicalization.
3. Review can accept the suggestion or edit the relation type, direction and
   constraint. The `reviewed_*` fields preserve the original suggestion.
4. Preview computes `planDigest` through `resolveEffectiveProposal`, so preview
   and apply show and materialize the reviewed values.
5. Apply requires an approved proposal and a matching digest. It writes the
   relation into `skill_relations` with provenance (`proposalId`, actor,
   timestamps and origin) and modifies neither skills nor `SKILL.md`.

## Discovery modes

- `strict`: explicit operational predicates and the smallest FTS candidate set.
- `balanced` (default): explicit references, bounded FTS, and tags/metadata as
  candidate-generation signals.
- `exploratory`: a widened top-K to enrich human review, with edges always
  rendered dotted until apply.

`confidence` means "confidence in the suggestion", not authorization. The UI
filters only prioritize the queue.

## Review and safety

- Manual relations are staged as proposals too (`origin=manual`,
  `detector=manual`); they never write the graph directly.
- Self-relations are rejected.
- Edited proposals are marked `EDITED`; batch accept should only be used for
  proposals with no individual edits.
- Once applied, `skill_relations` is immutable. Later changes require another
  governed operation.
- Capabilities stay separate: `skill.relation.proposal.read`, `.create`,
  `.review`, `.apply`.

## Compatibility and portability

Migration 0019 adds nullable/defaulted fields for pre-existing proposals, so an
old proposal resolves to exactly its original values. The existing export
includes `skill-relations.json`; import and export do not depend on relations
declared in frontmatter.
