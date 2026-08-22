export const skillRoutes = [
  { method: 'GET', pattern: /^\/api\/v1\/skills$/, operationId: 'listSkills', cas: false },
  { method: 'GET', pattern: /^\/api\/v1\/skills\/([^/]+)\/versions$/, operationId: 'listSkillVersions', cas: false },
] as const;

export type SkillRoute = (typeof skillRoutes)[number];
