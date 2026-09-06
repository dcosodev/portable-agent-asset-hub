# `@portable-agent-asset-hub/graph-ui`

Read-mostly Web Graph Explorer: a React + Cytoscape.js UI for browsing the
versioned skill graph, plus its own BFF (backend-for-frontend) server.

## What lives here

- **`src/App.tsx`**, **`GraphView.tsx`**, **`GraphCanvas.tsx`** — the app
  shell and the Cytoscape canvas rendering nodes/edges from the graph DTOs
  `core` produces.
- **`Inspector.tsx`**, **`FilterPanel.tsx`**, **`Toolbar.tsx`**,
  **`StatusBar.tsx`** — UI chrome: inspecting a selected node, filtering
  the visible graph, top-level actions, status feedback.
- **`ExplicitRelationQueue.tsx`**, **`ManualRelationDialog.tsx`**,
  **`RelationProposal*.tsx`** — the review workflow for relation proposals:
  queue, manual creation dialog, apply-preview, inspector, and the queue
  UI itself. This is the human-in-the-loop side of
  [`../../docs/relation-proposal-workflow.md`](../../docs/relation-proposal-workflow.md).
- **`SkillReader.tsx`**, **`MarkdownViewer.tsx`** — read a skill's body/
  resources as rendered Markdown.
- **`state/useExplorerState.ts`**, **`state/useFilters.ts`** — app state.
- **`api.ts`**, **`graph-model.ts`**, **`types.ts`** — the data layer
  between the BFF's REST calls and the graph rendering model.
- **`server.ts`** (the BFF, built to `dist-server/`) — see
  `server.test.ts`, `server-allowlist.test.ts`, `server-lan.test.ts` for
  its contract: it never opens SQLite, forwards only an anchored allowlist
  of governed relation-proposal write actions, and refuses every mutation
  when serving to a private LAN (opt-in only).

## Role in the system

This is strictly a REST client. It never touches SQLite or the filesystem
directly; every read and the handful of allowlisted writes go through the
REST API. See
[`../../docs/web-graph-explorer.md`](../../docs/web-graph-explorer.md) for
the full security posture (loopback-by-default, LAN opt-in, allowlist
scope).

## Build & run

```sh
pnpm --filter @portable-agent-asset-hub/graph-ui dev     # local dev server
pnpm --filter @portable-agent-asset-hub/graph-ui build    # vite build + BFF tsc
pnpm --filter @portable-agent-asset-hub/graph-ui start     # build then run dist-server/server.js
```

Needs a running REST hub to have any data to show — see the "Optional:
browse the canonical skill graph" step in the root
[`README.md`](../../README.md#quickstart).

Note: `graph-ui` is deliberately outside the root `tsconfig.json` project
references (it compiles JSX under its own `tsconfig.json` and
`tsconfig.server.json`), so `pnpm build`/`pnpm test`/`pnpm lint` at the
workspace root always run it as a separate `pnpm --filter` leg.
