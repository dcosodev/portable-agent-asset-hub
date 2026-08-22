import type { AgentId, HarnessId, Scope, UserId } from '../identity/types.js';

export type ActorContext = Readonly<{
  userId: UserId;
  agentId: AgentId;
  harnessId?: HarnessId;
  scope: Scope;
  role: 'user' | 'agent' | 'admin';
  capabilities: readonly string[];
}>;

export type AuthenticatedActor = {
  userId: UserId;
  agentId: AgentId;
  harnessId?: HarnessId;
  role: ActorContext['role'];
  capabilities: readonly string[];
};

export function createActorContextFromAuthenticated(
  authenticated: AuthenticatedActor,
  _requestPayload?: unknown,
): ActorContext {
  void _requestPayload;
  const scope: Scope = { ownerUserId: authenticated.userId, agentId: authenticated.agentId };
  return Object.freeze({
    userId: authenticated.userId,
    agentId: authenticated.agentId,
    harnessId: authenticated.harnessId,
    role: authenticated.role,
    capabilities: Object.freeze([...authenticated.capabilities]),
    scope: Object.freeze(scope),
  });
}

export function createActorContext(input: AuthenticatedActor): ActorContext {
  return createActorContextFromAuthenticated(input);
}

export function actorScope(context: ActorContext): Scope {
  return context.scope;
}
