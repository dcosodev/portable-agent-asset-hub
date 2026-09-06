# `@portable-agent-asset-hub/sdk-python` (`pah_client`)

Python client for the hub, generated from the same
[`../../openapi/openapi.yaml`](../../openapi/openapi.yaml) contract as the
TypeScript SDK and the REST/MCP surfaces.

## What lives here

- **`src/pah_client/client.py`** — the `Client` class: typed methods per
  operation, over the generated low-level client.
- **`src/pah_client/errors.py`** — `SdkError`, raised on a non-2xx response
  or transport failure.
- **`src/pah_client/__init__.py`** — exports `Client` and `SdkError`.
- **`generated/`** — the `python` output from OpenAPI Generator `7.10.0`,
  with its own `PROVENANCE.json`, `pyproject.toml`, and
  `contract_fixtures/`, mirroring the TypeScript SDK's generated tree.
- **`pyproject.toml`** / **`setup.py`** (package root) — packaging for the
  hand-maintained `pah_client` layer that wraps `generated/`.

## Never hand-edit `generated/`

Same rule as the TypeScript SDK: regenerate with the pinned toolchain.

```sh
pnpm s6:generate   # requires Java 17 + OpenAPI Generator 7.10.0
pnpm s6:drift      # confirms the contract and the generated output agree
```

## See also

[`../sdk-ts/README.md`](../sdk-ts/README.md) — the equivalent TypeScript
SDK, generated from the same contract with the same pinned tool version.
