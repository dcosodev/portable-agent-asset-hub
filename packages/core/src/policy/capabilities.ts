export const CAPABILITIES = ['read','write.memory','write.skill','write.catalog','write.profile','admin.materialize','admin.snapshot','admin.replay','admin.sync','admin.doctor','admin.migrate'] as const;
export type Capability = typeof CAPABILITIES[number];
export type ActorRole = 'user'|'agent'|'admin';
