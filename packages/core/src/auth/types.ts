import type { ActorRole, Capability } from '../policy/capabilities.js';
import type { AgentId, HarnessId, UserId } from '../identity/types.js';

export type AuthMode = 'bearer' | 'local-dev';
export type CredentialStatus = 'active' | 'revoked';

export type CredentialBinding = Readonly<{
  credentialId: string;
  userId: UserId;
  agentId: AgentId;
  runtime: string;
  profile: string;
  harnessId?: HarnessId;
  role: ActorRole;
  capabilities: readonly Capability[];
  scope: Readonly<{ ownerUserId: UserId; agentId: AgentId }>;
  status: CredentialStatus;
  createdAt: string;
  revokedAt?: string;
}>;

export type IssuedCredential = Readonly<{
  id: string;
  token: string;
  fingerprint: string;
  binding: CredentialBinding;
}>;