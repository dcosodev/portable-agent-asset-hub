## Summary

Describe the change and the user-visible or contract-level effect.

## Scope

- [ ] Contract/API change
- [ ] Runtime/materializer change
- [ ] Migration or persistence change
- [ ] Documentation only
- [ ] Security/privacy relevant

## Verification

Commands run and relevant exit codes:

```text
pnpm lint
pnpm typecheck
pnpm test
```

If you ran a local gate, include its exit code and a short summary of its evidence.

## Public-surface checklist

- [ ] No secrets, cookies, sessions, private skills or runtime databases included.
- [ ] No developer-specific absolute paths included.
- [ ] Documentation and package metadata match the implementation.
- [ ] Generated artifacts were regenerated with the pinned toolchain, or the change does not affect them.
- [ ] Tests cover the changed behavior.
