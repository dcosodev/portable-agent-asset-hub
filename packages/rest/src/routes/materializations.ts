export const materializationRoutes = [
  { method: 'POST', pattern: /^\/api\/v1\/materializations\/preview$/, operationId: 'previewMaterialization', cas: false },
  { method: 'POST', pattern: /^\/api\/v1\/materializations\/apply$/, operationId: 'applyMaterialization', cas: true },
  { method: 'POST', pattern: /^\/api\/v1\/materializations\/([^/]+)\/rollback$/, operationId: 'rollbackMaterialization', cas: true },
] as const;

export type MaterializationRoute = (typeof materializationRoutes)[number];
