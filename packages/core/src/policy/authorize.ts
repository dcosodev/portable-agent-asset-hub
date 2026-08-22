import type { Capability, ActorRole } from './capabilities.js';

export type AuthorizationPolicy = {
  role: ActorRole;
  capabilities?: readonly Capability[];
  adminPolicy?: { allow: boolean };
};

export function authorize(policy: AuthorizationPolicy, capability: Capability): void {
  if (policy.role === 'admin' && policy.adminPolicy?.allow !== true) {
    throw new HubError('FORBIDDEN', 'administrator capabilities are disabled by default', 403);
  }
  if (!policy.capabilities?.includes(capability)) {
    throw new HubError('FORBIDDEN', `capability denied: ${capability}`, 403);
  }
}

import { HubError } from '../errors.js';
