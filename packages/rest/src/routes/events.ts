export const eventRoutes = [
  { method: 'POST', pattern: /^\/api\/v1\/events$/, operationId: 'createEvent', cas: false },
] as const;

export type EventRoute = (typeof eventRoutes)[number];
