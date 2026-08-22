export type OpaqueId<P extends string> = `${P}_${string}`;
export type UserId = OpaqueId<'usr'>; export type AgentId = OpaqueId<'agt'>; export type HarnessId = OpaqueId<'hrn'>; export type BindingId = OpaqueId<'bnd'>;
export type User = { id: UserId; kind: 'user'; displayName: string; createdAt: string };
export type Agent = { id: AgentId; kind: 'agent'; ownerUserId: UserId; name: string; createdAt: string };
export type Harness = { id: HarnessId; kind: 'harness'; name: string; runtime: string; createdAt: string };
export type Scope = { ownerUserId: UserId; agentId: AgentId };
export type Binding = { id: BindingId; assetId: string; scope: Scope; harnessId: HarnessId; version: number; createdAt: string; revokedAt?: string };
export type Identity = User | Agent | Harness;
export const idPrefix = { user: 'usr_', agent: 'agt_', harness: 'hrn_', binding: 'bnd_' } as const;
export function hasOpaquePrefix(value: string, prefix: keyof typeof idPrefix): boolean { return value.startsWith(idPrefix[prefix]) && value.length > idPrefix[prefix].length; }
