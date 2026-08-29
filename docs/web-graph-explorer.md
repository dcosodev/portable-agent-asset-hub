# Web Graph Explorer

## Purpose and limits

The Web Graph Explorer is a human-facing, local, strictly read-only projection
of the canonical skill domain. SQLite remains the single source of truth; REST
enforces `ActorContext`, scope and capabilities; the UI writes no relations,
versions, resources or events.

The implementation covers:

- the global HEAD graph and an explicit versions mode;
- a focal graph with `dependencies`, `dependents` and `both`;
- transitive dependent impact;
- eight canonical relation types;
- REST search and visual filters;
- a modular shell: toolbar, view controls and an explicit layer selector;
- an opt-in FTS semantic neighborhood layer, kept out of the review queue;
- a node and edge inspector;
- safe rendering of `SKILL.md` and bounded textual resources;
- a Retrieval Explorer built exclusively on persisted `retrieval_events`;
- deep links `/skills/:id` and `/retrievals/:requestId`;
- `system`, `dark` and `light` themes;
- explicit truncation signalling.

## Architecture

```text
Browser (no bearer)
  │ GET /api/...
  ▼
Graph UI BFF (127.0.0.1)
  │ Authorization: Bearer <secret file 0600>
  ▼
REST / ActorContext / skill.read
  ▼
Core graph DTO + the existing resolver
  ▼
Canonical SQLite
```

The BFF:

- binds on loopback only;
- accepts only `GET` and `HEAD`;
- validates that the upstream REST URL is `http://127.0.0.1` or
  `http://localhost`;
- opens the bearer file with `O_NOFOLLOW`, rejects symlinks, and requires
  process ownership, a regular file and exactly `0600` permissions;
- never places the bearer in the bundle, a URL, the HTML, a response or a log;
- adds a CSP plus `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer` and `Cache-Control: no-store`;
- returns normalized errors without forwarding internal operational detail.

Under `AUTH_MODE=local-dev` the secret file may be omitted. In bearer mode it is
mandatory.

## Shell composition

`App.tsx` is a composition root, not a container. All explorer state — graph
loads, selection, filters, proposal queues, deep links — lives in
`state/useExplorerState.ts`, with the filter reducer split out into
`state/useFilters.ts`. Presentation is divided into `Toolbar`, `FilterPanel`,
`GraphCanvas`, `Inspector`, `SkillReader` and `StatusBar`, each of which takes
plain props and owns no fetching.

The split matters for one behavioral reason beyond tidiness: the FTS semantic
neighborhood is a *suggestion* surface, not a review surface. It is rendered as
an explicit graph layer that the operator turns on from the toolbar, and
`FTS_SEMANTIC_PROPOSAL_DETECTOR` keeps those suggestions out of the relation
proposal queue. A semantic neighbor never reaches the governed review flow by
being merely visible.

The workspace keeps all five tracks — toolbar, filters, canvas, inspector and
queues — usable below 1100px rather than dropping any of them, and
`ResponsiveLayout.test.ts` pins that.

## Why Cytoscape.js

Cytoscape.js was chosen because it offers an explicit node/edge model,
selection, zoom and pan, force-directed and hierarchical layouts, selector-based
styling and incremental updates — in a library specialized in graphs.

- Sigma.js is excellent at WebGL rendering of very large graphs, but it demands
  more bespoke work for semantic interaction, edge labels and a directed
  inspector.
- React Flow is optimized for diagram and flow editors; its DOM/SVG model and
  editing ergonomics are not the best foundation for a read-only explorer over
  hundreds or thousands of elements.
- Cytoscape lets us keep labels, arrows, line patterns and selection without
  turning the UI into a second implementation of the resolver.

Edges do not rely on color alone: they combine a label, an arrow, a pattern
(`solid`, `dashed`, `dotted`) and a tip shape. `conflicts_with` and `related_to`
are rendered symmetrically; every other type keeps its direction.

## Graph DTO

`GraphSkillNode` and `GraphRelationEdge` live in core and expose no SQLite rows.
Full bodies are not part of the global graph. Each node carries identification,
`skillId`, version, lifecycle, checksums, size, bounded metadata and resource
metadata. Bodies and resource bytes are fetched only when the inspector opens.

In HEAD mode the visual `id` equals the `skillId`. In versions mode the visual
`id` is `<skillId>@<version>` and `skillId` keeps the canonical identifier.
Historical relations use the exact versioned ids.

Every endpoint returns effective limits, counts and `truncated`,
`truncatedNodes` and `truncatedEdges`. Edges whose source or target is absent
from the DTO are never returned.

The focal graph shows all relations adjacent to the visited node, but continues
expanding only through types declared `transitive` in `SKILL_RELATION_TYPES`.
That way relations such as `related_to`, `conflicts_with` or `uses` appear one
hop out without being turned into an artificial transitive chain.

## REST endpoints

- `GET /api/v1/graph/skills`
- `GET /api/v1/skills/{id}/graph`
- `GET /api/v1/skills/{id}/impact`
- `GET /api/v1/retrieval-events`
- `GET /api/v1/retrieval-events/{id}/graph`

Relevant query parameters:

- `versions=heads|history`
- `mode=dependencies|dependents|both`
- `depth`, `maxNodes`, `maxEdges`
- `includeQuery=true` to list the already-redacted query of audited events

All five operations are marked `x-mcp.exposed: false`: they are a human REST
surface, not new MCP tools. OpenAPI and the TypeScript/Python SDKs do include
them.

## Performance and limits

The global graph loads heads, versions and resources through aggregate queries
rather than one query per node. The response projection is bounded by
`maxNodes` / `maxEdges`, relations are loaded in bulk, and bodies are not loaded
at all. In catalogs with an extraordinarily large history, the aggregate read
that precedes trimming can consume memory proportional to the visible rows; use
HEAD mode or the focal graph until storage grows SQL-level pagination over
history.

Defaults:

- depth: 4;
- nodes: 200;
- edges: 1,000.

Absolute limits:

- depth: 32;
- nodes: 4,096;
- edges: 16,384.

For dense graphs, prefer HEAD mode, relation filters and the focal graph. The
bundle splits React, Markdown and Cytoscape into independent chunks.

## Running it locally

```bash
pnpm build

AGENT_MEMORY_DB_PATH=/absolute/path/hub.sqlite \
  pnpm --filter @portable-agent-asset-hub/rest rest-entry

install -m 0600 /dev/null /absolute/path/graph-ui.token
# Write the bearer already issued by the control plane, outside of any log.

GRAPH_UI_REST_URL=http://127.0.0.1:39421 \
GRAPH_UI_BEARER_FILE=/absolute/path/graph-ui.token \
GRAPH_UI_PORT=4173 \
pnpm graph-ui
```

Then open `http://127.0.0.1:4173/`.

## Content security

`react-markdown` does not enable raw HTML, and `rehype-sanitize` applies an
allowlist. Resources are previewed only when their MIME type is a known textual
one and their size is at most 256 KiB. Binaries and large resources stay in
metadata-only mode.

The CSP keeps `style-src 'unsafe-inline'` because Cytoscape positions its canvas
and layers through runtime styles. That exception is scoped to the loopback BFF,
with scripts, connections and content restricted to `'self'`; the same policy
must not be reused if the UI is ever served off loopback.

## Verification

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm s6:drift
curl -fsS http://127.0.0.1:39422/api/v1/admin/doctor | jq -e '.ok == true'
sqlite3 /absolute/path/hub.sqlite 'PRAGMA integrity_check; PRAGMA foreign_key_check;'
```

The focal tests cover global and focal projection, non-transitive one-hop
expansion, versions mode, historical retrieval fidelity, impact, limits without
dangling edges, scope non-leakage, persisted retrieval events, the `skill.read`
capability, DTO parsing, node and edge rendering, search, selection, markdown,
truncation, the loopback BFF, symlink rejection and `0600` permissions.
