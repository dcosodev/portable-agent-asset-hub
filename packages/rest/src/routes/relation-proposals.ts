export const relationProposalRoutes = [
  { method: 'POST', pattern: /^\/api\/v1\/skill-relation-proposals$/, operationId: 'createManualSkillRelationProposal', cas: true, capability: 'skill.relation.proposal.create' },
  { method: 'GET', pattern: /^\/api\/v1\/skill-relation-proposals$/, operationId: 'listSkillRelationProposals', cas: false, capability: 'skill.relation.proposal.read' },
  { method: 'GET', pattern: /^\/api\/v1\/skill-relation-proposals\/([^/]+)$/, operationId: 'getSkillRelationProposal', cas: false, capability: 'skill.relation.proposal.read', paramNames: ['id'] },
  { method: 'POST', pattern: /^\/api\/v1\/skill-relation-proposals\/discover$/, operationId: 'discoverSkillRelationProposals', cas: false, capability: 'skill.relation.proposal.create' },
  { method: 'POST', pattern: /^\/api\/v1\/skill-relation-proposals\/([^/]+)\/approve$/, operationId: 'approveSkillRelationProposal', cas: true, capability: 'skill.relation.proposal.review', paramNames: ['id'] },
  { method: 'POST', pattern: /^\/api\/v1\/skill-relation-proposals\/([^/]+)\/reject$/, operationId: 'rejectSkillRelationProposal', cas: true, capability: 'skill.relation.proposal.review', paramNames: ['id'] },
  { method: 'POST', pattern: /^\/api\/v1\/skill-relation-proposals\/apply-preview$/, operationId: 'previewSkillRelationProposalApply', cas: false, capability: 'skill.relation.proposal.apply' },
  { method: 'POST', pattern: /^\/api\/v1\/skill-relation-proposals\/apply$/, operationId: 'applySkillRelationProposals', cas: true, capability: 'skill.relation.proposal.apply' },
  { method: 'POST', pattern: /^\/api\/v1\/skill-relation-proposals\/reconcile-canonical-duplicates$/, operationId: 'reconcileSkillRelationProposalDuplicates', cas: true, capability: 'skill.relation.proposal.apply' },
] as const;
