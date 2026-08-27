// packages/rest/src/routes/memories.ts
//
// Memory REST routes. Order matters: the literal `/memories/search`
// route must appear BEFORE the path-parameter `/memories/{id}` route
// in the registry, otherwise the router would capture `search` as the
// `id` parameter. The REST `app.ts` performs a first-match scan over
// `routes`, so this file's ordering is the single source of truth for
// which route "wins" when both patterns could match a given URL.
export const memoryRoutes = [
  { method: 'POST', pattern: /^\/api\/v1\/memories$/, operationId: 'createMemory', cas: false },
  { method: 'POST', pattern: /^\/api\/v1\/memories\/([^/]+)\/supersede$/, operationId: 'supersedeMemory', cas: true },
  { method: 'POST', pattern: /^\/api\/v1\/memories\/([^/]+)\/forget$/, operationId: 'forgetMemory', cas: true },
  { method: 'GET', pattern: /^\/api\/v1\/memories\/search$/, operationId: 'searchMemories', cas: false },
  { method: 'GET', pattern: /^\/api\/v1\/memories\/([^/]+)$/, operationId: 'getMemory', cas: false },
] as const;

export type MemoryRoute = (typeof memoryRoutes)[number];