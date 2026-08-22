export const memoryRoutes = [
  { method: 'POST', pattern: /^\/api\/v1\/memories$/, operationId: 'createMemory', cas: false },
  { method: 'POST', pattern: /^\/api\/v1\/memories\/([^/]+)\/supersede$/, operationId: 'supersedeMemory', cas: true },
  { method: 'POST', pattern: /^\/api\/v1\/memories\/([^/]+)\/forget$/, operationId: 'forgetMemory', cas: true },
] as const;

export type MemoryRoute = (typeof memoryRoutes)[number];