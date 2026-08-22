export const profileRoutes = [
  { method: 'POST', pattern: /^\/api\/v1\/profiles$/, operationId: 'createProfile', cas: false },
] as const;

export type ProfileRoute = (typeof profileRoutes)[number];
