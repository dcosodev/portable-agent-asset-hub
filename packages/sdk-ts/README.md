# `@portable-agent-asset-hub/sdk-ts`

A small hand-written TypeScript client (`Client`, `SdkError`), plus a separate
**generated** client produced from the OpenAPI document:
[`../../openapi/openapi.yaml`](../../openapi/openapi.yaml).

## What lives here

- **`src/client.ts`** — the `Client` class: a generic `request` method,
  `health` and `status` helpers, structured errors, and request and response
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
pnpm sdk:generate   # requires Java 17 + OpenAPI Generator 7.10.0
pnpm openapi:drift      # confirms openapi/openapi.yaml and the generated output agree
```

`pnpm openapi:drift` runs in CI on every change; a manual edit to `generated/`
will be silently overwritten and is not the source of truth for anything.

## Build

```sh
pnpm --filter @portable-agent-asset-hub/sdk-ts build
```

## See also

[`../sdk-python/README.md`](../sdk-python/README.md) — the equivalent
Python SDK, generated from the same contract with the same pinned tool
version.
