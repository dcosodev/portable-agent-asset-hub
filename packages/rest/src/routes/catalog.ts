export const catalogRoutes = [
  { method: 'GET', pattern: /^\/api\/v1\/catalog\/search$/, operationId: 'searchCatalog', cas: false },
  { method: 'GET', pattern: /^\/api\/v1\/resources\/(.+)$/, operationId: 'getResource', cas: false },
  { method: 'GET', pattern: /^\/api\/v1\/catalog$/, operationId: 'getCatalog', cas: false },
] as const;

export type CatalogRoute = (typeof catalogRoutes)[number];
