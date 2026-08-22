# End-to-end demo

A five-minute, fully local walkthrough of the hub's core loop: a profile
stored in the governed SQLite store is materialized into a (throwaway)
Hermes target directory over the real REST surface, drift is detected,
and the run is rolled back — with every step audited.

## Run it

```sh
pnpm install
pnpm build
node examples/demo/demo.mjs
```

No network, no credentials, no Java: the demo touches only a temporary
directory (removed at the end) and exercises the same code paths the
integration tests use.

## What it shows

| Step | Surface | What happens |
| --- | --- | --- |
| 1 | `SqliteStore.transaction` | A profile (`prf_demo`, two blocks) is created in an audited transaction. |
| 2 | `listen` (REST) | The `node:http` server starts in loopback `localMode`; `GET /api/v1/health` answers. |
| 3 | `POST /api/v1/materializations/preview` | The Hermes materializer plans `USER.md`, `MEMORY.md`, `SKILL.md` with per-file SHA-256 digests and an observed digest of the (empty) target. |
| 4 | `POST /api/v1/materializations/apply` (no `If-Match`) | Rejected with `428 PRECONDITION_REQUIRED` — the CAS contract is enforced at the route table (`x-cas-required`). |
| 5 | Apply with `If-Match` | The plan is staged, verified byte-for-byte, backed up, and published; the response carries the `runId`. |
| 6 | Tamper + apply | A byte mutation of `MEMORY.md` after the apply makes the observed digest drift; the second apply is rejected with `412 PRECONDITION_FAILED`. |
| 7 | `POST /api/v1/materializations/{run_id}/rollback` | The run is rolled back: files the apply replaced get their prior bytes, files it added over no prior bytes are removed. The target returns to its exact pre-apply state. |
| 8 | `store.diagnostics()` | The audit counts show every mutation (create, apply, rollback) left a trail. |

## Expected output (abridged)

```text
=== 4. CAS contract: apply without If-Match is rejected
    status: 428 (PRECONDITION_REQUIRED)

=== 5. Apply with If-Match
    status: 200
    runId: run_…

=== 6. Tamper with the target: drift is detected (412)
    status: 412 (PRECONDITION_FAILED)

=== 7. Roll back the run: prior bytes are restored
    status: 200
    MEMORY.md after rollback: (removed — target restored to pre-apply state)
```

## Using the generated SDKs instead

The same operations are available through the generated clients (see
`packages/sdk-ts/` and `packages/sdk-python/`; regeneration requires
Java 17 + OpenAPI Generator 7.10.0):

```ts
// TypeScript: the generated typescript-fetch tree exposes DefaultApi
// (packages/sdk-ts/generated/); the package root wraps it as Client.
import { Configuration, DefaultApi } from '@portable-agent-asset-hub/sdk-ts/generated';

const api = new DefaultApi(new Configuration({ basePath: 'http://127.0.0.1:8787' }));
await api.getHealth();
```

```python
# Python: the generated package is openapi_client
# (packages/sdk-python/generated/).
import openapi_client

configuration = openapi_client.Configuration(host="http://127.0.0.1:8787")
with openapi_client.ApiClient(configuration) as client:
    openapi_client.DefaultApi(client).get_health()
```

> The source of truth is the generator output under each `generated/`
> tree (see its `PROVENANCE.json`), never hand-written wrappers.
