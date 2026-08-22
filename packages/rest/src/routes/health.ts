export const healthRoutes = [
  { method: 'GET', pattern: /^\/api\/v1\/health$/, operationId: 'getHealth', cas: false },
  { method: 'GET', pattern: /^\/api\/v1\/status$/, operationId: 'getStatus', cas: false },
] as const;

export type HealthRoute = (typeof healthRoutes)[number];
