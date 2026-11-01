# Contributing

Thank you for considering a contribution. For API changes, update `openapi/openapi.yaml` first, then the implementation, and keep the two in step.

## Before opening a pull request

```sh
pnpm install --frozen-lockfile
pnpm docs:check
pnpm lint
pnpm --filter @portable-agent-asset-hub/graph-ui lint
pnpm typecheck
pnpm test
pnpm openapi:drift
```

These are what CI runs, plus the demo (`node examples/demo/demo.mjs`) and a
check that regenerating the MCP tool metadata is a no-op. Run them from a clean
checkout when the change touches the build graph: `pnpm install
--frozen-lockfile && pnpm build` must succeed without any pre-existing `dist/`
in the workspace.

Additional checks by surface:

| Touching | Also run | Needs |
|---|---|---|
| telemetry, spans, metrics, attributes | `pnpm observability:lint`, `pnpm observability:contract` | nothing |
| the Docker or Compose stack | `pnpm docker:contract` | nothing |
| either of the above, before release | `pnpm docker:smoke` | a running Docker daemon |
| documentation or a document's links | `pnpm docs:check` | nothing |
| the OpenAPI contract or the SDKs | `pnpm openapi:drift`, `node scripts/generate-sdks.mjs` | Java 17 + OpenAPI Generator `7.10.0` |

The longer local gates are described in [`docs/validation.md`](docs/validation.md);
they are not all green at present, and CI does not run them.

Include the fresh exit code and a concise artifact summary for whatever you
ran. Missing external tools must remain an explicit blocker rather than being
hidden with a fallback: do not weaken a gate to make it pass in an environment
that cannot run it.

## Change expectations

- Keep changes focused and reversible.
- Update contracts, implementation, tests and documentation together.
- Do not edit generated SDKs manually; regenerate them with the pinned toolchain.
- Keep refusals in place: a check that rejects bad input or missing tools must not start passing silently. Preserve concurrency protections.
- Do not commit `node_modules/`, `dist/`, `artifacts/`, `.tmp-*`, credentials, private runtime state or local caches.
- Do not include personal skills, profiles, cookies, tokens, sessions or database files.
- Do not add developer-specific absolute paths to source, documentation, fixtures or provenance.

## Pull requests

Use the pull request template and explain the compatibility, migration and security impact of the change. Include commands and exit codes for the checks you actually ran. Do not claim a live-provider or hosted integration test if it was not executed.

## Licensing contributions

Unless a contribution is explicitly marked otherwise and accepted by the maintainer, contributions are submitted under the Apache License 2.0, with the same copyright and patent terms that apply to the project. Contributors retain copyright in their contributions.

By contributing, you confirm that you have the right to submit the work and that it does not contain third-party or private material that you are not authorized to publish.
