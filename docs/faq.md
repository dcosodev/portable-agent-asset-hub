# FAQ / troubleshooting

Answers to the questions this repository's own validation output raises
most often. `pnpm docs:check` checks this document's links but not its prose,
so open an issue if you find something out of date.

## "Node prints `ExperimentalWarning: SQLite is an experimental feature`"

Expected. `@portable-agent-asset-hub/storage-sqlite` uses the built-in
`node:sqlite` module, which is still experimental on the supported
`>=22.16.0` Node line. It is harmless and does not affect correctness; the
limitation is recorded here and in gate evidence rather than suppressed
with a flag.

## "`pnpm openapi:gate` / `pnpm sdk:generate` fails on my machine"

SDK generation requires **Java 17** and **OpenAPI Generator `7.10.0`** on
`PATH`, pinned exactly. Without them, generation exits with an error rather
than writing placeholder SDKs. `openapi:gate` also re-runs earlier local
gates, which are not all green at present; see
[`validation.md`](validation.md#local-gates). CI runs neither command.

You don't need the toolchain for what CI runs: `docs:check`, `lint`,
`typecheck`, `test` and `openapi:drift`. The demo
(`node examples/demo/demo.mjs`) needs neither Java nor network.

## "`pnpm docker:smoke` hangs or fails immediately"

It needs a running Docker daemon — it builds both images and drives the
live observability stack end to end. If you only want to check the
Compose/Collector configuration statically (no daemon), use
`pnpm docker:contract` instead. See
[`../observability/README.md`](../observability/README.md).

## "A query in a language other than Spanish or English isn't finding my skills"

Working as documented, not a bug: the mandatory-retrieval classifier
(`packages/core/src/skills/retrieval.ts`) matches a fixed Spanish/English
keyword table. Anything else falls back to the `general_knowledge`
category, which does not trigger mandatory skill retrieval. See the
"Language support" note in
[`skill-graph-retrieval.md`](skill-graph-retrieval.md#language-support).

## "I called `list_skills` / `list_skill_versions` over MCP and it's gone"

Both were removed in `0.2.0`. Read skills with `searchSkills`, `getSkill`,
`listSkillResources` and `readSkillResource`. See
[Removed in 0.2.0](api-surface.md#removed-in-020) and
[`CHANGELOG.md`](../CHANGELOG.md).

## "My apply/mutation was rejected with `428 PRECONDITION_REQUIRED`"

Working as designed. Any route marked `x-cas-required: true` in the
OpenAPI contract needs a matching `If-Match` header — this is the
optimistic-concurrency contract, not an auth error. Run a `preview` first
to get the current digest, then send it back as `If-Match` on the mutating
call. See [`api-surface.md`](api-surface.md) for which routes require it,
and [`demo.md`](demo.md) for a worked example (steps 4–6).

## "My apply was rejected with `412 PRECONDITION_FAILED`" after `If-Match` worked once

The target drifted between your `preview` and your `apply` — someone or
something changed the files after the digest you're holding was computed.
Re-run `preview` to get a fresh digest and retry. This is the same drift
detection [`demo.md`](demo.md) exercises deliberately (step 6).

## "Where do I report a security issue?"

See [`SECURITY.md`](../SECURITY.md). There is no hosted service and no
response-SLA — read that file before assuming otherwise.
