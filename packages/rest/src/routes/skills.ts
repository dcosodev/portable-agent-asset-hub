// packages/rest/src/routes/skills.ts
//
// Skill REST routes. Order matters: the literal
// `/api/v1/skills/search` route MUST be declared BEFORE the
// path-parameter `/api/v1/skills/{id}` route in the registry, otherwise
// the router would capture `search` as the `{id}` parameter. The REST
// `app.ts` performs a first-match scan over `routes`, so this file's
// ordering is the single source of truth for which route "wins" when
// both patterns could match a given URL.
//
// Path encoding for resource reads:
//
//   * `/api/v1/skills/{id}/resources` (list)  — captures `{id}` only.
//   * `/api/v1/skills/{id}/resources/{resourcePath}` (read) — captures
//     `{id}` and `{resourcePath}`. The `resourcePath` segment may
//     contain POSIX slashes (e.g. `bin/run.sh`) so the capture is
//     greedy and stops at the end of the path. The router MUST NOT
//     introduce a collision with the legacy `/api/v1/resources/{path}`
//     route declared in `catalog.ts` — the legacy route lives under a
//     different top-level segment so the two cannot conflict, and the
//     router's first-match scan plus the `skillRoutes` ordering keeps
//     the skill surface isolated.
//
// CAS: the four skill operations are read-only; no `cas: true` flag.
//
// Lifecycle visibility: the agent-facing REST surface (`getSkill`,
// `listSkillResources`, `readSkillResource`) MUST refuse to materialize
// inactive rows so the runtime cannot accidentally serve a `stale` /
// `rejected` / `candidate` version of a skill as if it were the active
// head. The historical repository (`getVersion`) remains reachable via
// the storage layer for audit / replay, but the REST surface does not
// expose it directly — that is by design and is documented in
// `launcher.ts`.
export const skillRoutes = [
  // Literal high-level resolvers must precede /skills/{id}.
  { method: 'GET', pattern: /^\/api\/v1\/graph\/skills$/, operationId: 'getGlobalSkillGraph', cas: false, capability: 'skill.read' },
  { method: 'GET', pattern: /^\/api\/v1\/retrieval-events$/, operationId: 'listRetrievalEvents', cas: false, capability: 'skill.read' },
  { method: 'GET', pattern: /^\/api\/v1\/retrieval-events\/([^/]+)\/graph$/, operationId: 'getRetrievalEventGraph', cas: false, capability: 'skill.read', paramNames: ['id'] },
  { method: 'POST', pattern: /^\/api\/v1\/retrieval\/resolve$/, operationId: 'resolveRetrieval', cas: false },
  { method: 'POST', pattern: /^\/api\/v1\/skills\/resolve$/, operationId: 'resolveSkillGraph', cas: false },
  // 1. Literal-first: search MUST appear before /skills/{id}.
  { method: 'GET', pattern: /^\/api\/v1\/skills\/search$/, operationId: 'searchSkills', cas: false },
  { method: 'GET', pattern: /^\/api\/v1\/skills\/([^/]+)\/relations$/, operationId: 'getSkillRelations', cas: false, paramNames: ['id'] },
  { method: 'PUT', pattern: /^\/api\/v1\/skills\/([^/]+)\/relations$/, operationId: 'replaceSkillRelations', cas: true, paramNames: ['id'] },
  { method: 'GET', pattern: /^\/api\/v1\/skills\/([^/]+)\/dependents$/, operationId: 'getSkillDependents', cas: false, paramNames: ['id'] },
  { method: 'GET', pattern: /^\/api\/v1\/skills\/([^/]+)\/graph$/, operationId: 'getSkillGraph', cas: false, capability: 'skill.read', paramNames: ['id'] },
  { method: 'GET', pattern: /^\/api\/v1\/skills\/([^/]+)\/impact$/, operationId: 'getSkillImpact', cas: false, capability: 'skill.read', paramNames: ['id'] },
  // 2. Path-parameter get of a single skill by id. The router will only
  //    fall through to this pattern when the URL does NOT match the
  //    literal `search` route above.
  { method: 'GET', pattern: /^\/api\/v1\/skills\/([^/]+)$/, operationId: 'getSkill', cas: false, paramNames: ['id'] },
  // 3. Resource list for the active head version of a skill.
  { method: 'GET', pattern: /^\/api\/v1\/skills\/([^/]+)\/resources$/, operationId: 'listSkillResources', cas: false, paramNames: ['id'] },
  // 4. Resource read for a specific path inside a skill. The capture is
  //    greedy and anchored at the end of the URL so multi-segment POSIX
  //    paths like `bin/run.sh` resolve correctly. The app.ts router
  //    splits the captured group into named params (`id` and
  //    `resourcePath`) and decodes them via `decodeURIComponent` before
  //    handing them to the dispatcher.
  {
    method: 'GET',
    pattern: /^\/api\/v1\/skills\/([^/]+)\/resources\/(.+)$/,
    operationId: 'readSkillResource',
    cas: false,
    paramNames: ['id', 'resourcePath'],
  },
] as const;

export type SkillRoute = (typeof skillRoutes)[number];
