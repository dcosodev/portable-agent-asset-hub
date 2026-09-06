# `@portable-agent-asset-hub/sdk-ts`

Hand-maintained TypeScript client (`Client`, `SdkError`) plus a
**generated** low-level client underneath it, both produced from the same
contract: [`../../openapi/openapi.yaml`](../../openapi/openapi.yaml).

## What lives here

- **`src/client.ts`** — the ergonomic `Client` class most consumers should
  use: typed methods per operation, structured errors, request/response
  handling.
- **`src/errors.ts`** — `SdkError`, the typed exception `Client` throws on
  a non-2xx response or transport failure.
- **`src/index.ts`** — the public export surface (`Client`, `SdkError`,
  `ClientOptions`, `ErrorBody`).
- **`generated/`** — the `typescript-fetch` output from OpenAPI Generator
  `7.10.0`, plus a `PROVENANCE.json` recording the exact tool version and
  source contract hash it was generated from.

## Never hand-edit `generated/`

Regenerate it with the pinned toolchain instead:

```sh
pnpm s6:generate   # requires Java 17 + OpenAPI Generator 7.10.0
pnpm s6:drift      # confirms the contract and the generated output agree
```

`pnpm s6:drift` runs in CI on every change; a manual edit to `generated/`
will be silently overwritten and is not the source of truth for anything.

## Build

```sh
pnpm --filter @portable-agent-asset-hub/sdk-ts build
```

## See also

[`../sdk-python/README.md`](../sdk-python/README.md) — the equivalent
Python SDK, generated from the same contract with the same pinned tool
version.
