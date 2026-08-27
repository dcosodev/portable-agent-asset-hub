import { createHash, randomBytes } from 'node:crypto';
import type { ActorContext } from '../runtime/actor-context.js';
import type { ActorRole, Capability } from '../policy/capabilities.js';
import type { AgentId, HarnessId, UserId } from '../identity/types.js';
import type { CredentialBinding, IssuedCredential } from './types.js';

export function hashCredential(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function fingerprintCredential(token: string): string {
  return hashCredential(token).slice(0, 16);
}

export function issueCredential(input: {
  credentialId: string;
  userId: UserId;
  agentId: AgentId;
  runtime: string;
  profile: string;
  harnessId?: HarnessId;
  role: ActorRole;
  capabilities: readonly Capability[];
  now?: string;
}): IssuedCredential {
  const token = `pah_${randomBytes(32).toString('base64url')}`;
  const createdAt = input.now ?? new Date().toISOString();
  const binding: CredentialBinding = Object.freeze({
    credentialId: input.credentialId,
    userId: input.userId,
    agentId: input.agentId,
    runtime: input.runtime,
    profile: input.profile,
    harnessId: input.harnessId,
    role: input.role,
    capabilities: Object.freeze([...input.capabilities]),
    scope: Object.freeze({ ownerUserId: input.userId, agentId: input.agentId }),
    status: 'active',
    createdAt,
  });
  return Object.freeze({ id: input.credentialId, token, fingerprint: fingerprintCredential(token), binding });
}

export function actorContextFromCredential(binding: CredentialBinding, requested?: readonly string[]): ActorContext {
  const authorized = new Set<string>(binding.capabilities);
  const effective = requested === undefined
    ? [...authorized]
    : requested.filter((capability) => authorized.has(capability));
  return Object.freeze({
    userId: binding.userId,
    agentId: binding.agentId,
    harnessId: binding.harnessId,
    role: binding.role,
    capabilities: Object.freeze(effective),
    scope: Object.freeze({ ...binding.scope }),
  });
}