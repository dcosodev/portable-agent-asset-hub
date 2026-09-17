// Package embed wires the Graph Explorer static bundle into the Go
// binary via `go:embed`. The contract (docs/roadmap/slices.json T4)
// is unambiguous about the runtime surface:
//
//   - hub open serves the embedded bundle on 127.0.0.1 only.
//   - The embedded tree is the production bundle built by
//     `pnpm --filter @portable-agent-asset-hub/graph-ui build`.
//   - Any non-loopback bind attempt is fail-closed at the dispatcher
//     boundary (see cmd/hub/cmd_open.go). This package only exposes
//     the bytes; the safety boundary lives in the handler.
//
// The package ships zero external dependencies and uses the Go
// standard library's `embed.FS` so the binary stays reproducible
// with `-trimpath`.
//
// Bundle provenance. The dist/ tree is populated by
// scripts/copy-graph-ui-bundle.mjs (T4) which mirrors
// packages/graph-ui/dist/ into internal/embed/dist/. We deliberately
// do NOT use a symlink: `go:embed` follows the file at compile time
// and a symlink would force every developer / CI runner to keep
// packages/graph-ui/dist/ in lock-step with the embedded copy. The
// copy script is the single source of truth.
package embed

import "embed"

// Bundle is the embedded Graph Explorer dist tree. The directive
// pulls the entire dist/ subtree into the binary so `hub open` can
// serve index.html, assets/, and any future static file the bundle
// ships. The variable is exported so cmd_open.go's HTTP handler can
// mount it at the document root.
//
//go:embed dist
var Bundle embed.FS
