# Contributing

Thank you for considering a contribution. This project follows a contract-first, reproducible and fail-closed development model.

## Before opening a pull request

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
```

For changes touching a staged surface, also run the relevant gate and include the fresh exit code and a concise artifact summary. S6 requires Java 17 and OpenAPI Generator `7.10.0`; missing external tools must remain an explicit blocker rather than being hidden with a fallback.

## Change expectations

- Keep changes focused and reversible.
- Update contracts, implementation, tests and documentation together.
- Do not edit generated SDKs manually; regenerate them with the pinned toolchain.
- Preserve fail-closed behavior and concurrency protections.
- Do not commit `node_modules/`, `dist/`, `artifacts/`, `.tmp-*`, credentials, private runtime state or local caches.
- Do not include personal skills, profiles, cookies, tokens, sessions or database files.
- Do not add developer-specific absolute paths to source, documentation, fixtures or provenance.

## Pull requests

Use the pull request template and explain the compatibility, migration and security impact of the change. Include commands and exit codes for the checks you actually ran. Do not claim a live-provider or hosted integration test if it was not executed.

## Licensing contributions

Unless a contribution is explicitly marked otherwise and accepted by the maintainer, contributions are submitted under the Apache License 2.0, with the same copyright and patent terms that apply to the project. Contributors retain copyright in their contributions.

By contributing, you confirm that you have the right to submit the work and that it does not contain third-party or private material that you are not authorized to publish.
