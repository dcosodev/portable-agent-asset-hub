export const syncRoutes = [
  { method: 'POST', pattern: /^\/api\/v1\/catalog\/sync\/preview$/, operationId: 'previewCatalogSync', cas: false },
  { method: 'POST', pattern: /^\/api\/v1\/catalog\/sync\/apply$/, operationId: 'applyCatalogSync', cas: true },
] as const;

export type SyncRoute = (typeof syncRoutes)[number];
