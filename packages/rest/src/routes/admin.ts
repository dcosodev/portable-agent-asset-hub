export const adminRoutes = [
  { method: 'GET', pattern: /^\/api\/v1\/admin\/doctor$/, operationId: 'getDoctor', cas: false },
  { method: 'GET', pattern: /^\/api\/v1\/audit$/, operationId: 'listAudit', cas: false },
  { method: 'GET', pattern: /^\/api\/v1\/snapshots$/, operationId: 'listSnapshots', cas: false },
  { method: 'POST', pattern: /^\/api\/v1\/replay$/, operationId: 'replay', cas: false },
] as const;

export type AdminRoute = (typeof adminRoutes)[number];
