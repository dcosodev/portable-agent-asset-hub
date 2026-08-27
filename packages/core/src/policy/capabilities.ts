export const CAPABILITIES = ['read','capabilities.read','write.memory','write.skill','write.catalog','write.profile','skill.read','skill.resource.read','admin.materialize','admin.snapshot','admin.replay','admin.sync','admin.doctor','admin.migrate','skill.relation.proposal.read','skill.relation.proposal.create','skill.relation.proposal.review','skill.relation.proposal.apply'] as const;
export type Capability = typeof CAPABILITIES[number];
export type ActorRole = 'user'|'agent'|'admin';
