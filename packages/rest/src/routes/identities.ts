export const identityRoutes = [
  { method: 'GET', pattern: /^\/api\/v1\/identities$/, operationId: 'listIdentities', cas: false },
  { method: 'POST', pattern: /^\/api\/v1\/bindings$/, operationId: 'createBinding', cas: true },
] as const;

export type IdentityRoute = (typeof identityRoutes)[number];
