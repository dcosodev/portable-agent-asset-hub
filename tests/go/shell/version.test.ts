// tests/go/shell/version.test.ts
//
// T1 real-subprocess contract for `hub --version` / `hub version` /
// `hub version --json`. The tests build a temp hub binary with
// `go build -trimpath`, then spawn it for every case and assert on
// the LIVE output — no static regex over the source. The contract
// surface that this file locks in:
//
//   * `hub --version`              → exit 0, stdout matches
//                                    `^hub <semver> (go<gov>)$`.
//   * `hub version`                → same shape as above (alias).
//   * `hub version --json`         → exit 0, stdout is a JSON object
//                                    whose keys are EXACTLY the five
//                                    locked keys (service, hub, rest,
//                                    openapi, go) in a stable order.
//   * no bearer-shaped string      → neither stdout nor stderr ever
//                                    contains a bearer-shape match
//                                    (mirrors internal/output.Redact).
//   * stderr empty on success      → the contract surface is stdout
//                                    only; stderr is empty when the
//                                    command succeeded.
//   * deterministic across runs    → two consecutive invocations
//                                    produce byte-exact stdout.
//   * unknown subcommand           → exit 2 (contract violation),
//                                    diagnostic on stderr.

import { describe, expect, it } from 'vitest';
import { runHub } from './_hub-harness';

// Bearer-shape predicates for the inline `not.toMatch` assertions.
// Mirrors `_hub-harness.ts` and `internal/output/output.go`. JS
// regex literals do NOT support inline flags like `(?i)` — that is
// PCRE/Python/Ruby syntax — so we use the `i` flag on the RegExp
// literal here. Promoted to module scope to avoid recompiling on
// every assertion and to make the intent self-documenting.
const BEARER_PREFIXED_OPAQUE = /bearer\s+[A-Za-z0-9._~+/=-]{20,}/i;
const HUB_BEARER_ENV_ASSIGNMENT = /\bHUB_BEARER_TOKEN\b\s*=/i;
const JWT_TRIPLE_SEGMENT = /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/;

const VERSION_LINE_PATTERN = /^hub 0\.[0-9]+\.[0-9]+ \(go1\.[0-9]+\.[0-9]+\)$/;
const VERSION_JSON_KEYS = ['service', 'hub', 'rest', 'openapi', 'go'];

describe('hub version — human-readable contract', () => {
  it('--version_prints_deterministic_line_and_exits_zero', async () => {
    const res = await runHub(['--version']);
    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
    const line = res.stdout.trimEnd();
    expect(line).toMatch(VERSION_LINE_PATTERN);
  }, 30_000);

  it('version_subcommand_alias_matches_flag_form', async () => {
    const res = await runHub(['version']);
    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
    const line = res.stdout.trimEnd();
    expect(line).toMatch(VERSION_LINE_PATTERN);
  }, 30_000);

  it('two_consecutive_invocations_produce_byte_exact_stdout', async () => {
    const a = await runHub(['--version']);
    const b = await runHub(['--version']);
    expect(a.status).toBe(0);
    expect(b.status).toBe(0);
    expect(a.stdout).toBe(b.stdout);
  }, 30_000);

  it('human_output_contains_no_bearer_shaped_string', async () => {
    const res = await runHub(['version']);
    expect(res.status).toBe(0);
    // Belt-and-braces: the version line should never trip a bearer
    // pattern. The Go runtime's "go1.27.0" is too short to match
    // the 20+ char bearer pattern, but we still walk the line.
    expect(res.stdout).not.toMatch(BEARER_PREFIXED_OPAQUE);
    expect(res.stdout).not.toMatch(HUB_BEARER_ENV_ASSIGNMENT);
    expect(res.stdout).not.toMatch(JWT_TRIPLE_SEGMENT);
  }, 30_000);
});

describe('hub version --json — structured contract', () => {
  it('json_payload_parses_and_has_all_five_locked_keys', async () => {
    const res = await runHub(['version', '--json']);
    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
    // JSON is the ONLY stdout payload; no prose wrapper, no
    // trailing banner.
    const trimmed = res.stdout.trim();
    expect(trimmed.startsWith('{')).toBe(true);
    expect(trimmed.endsWith('}')).toBe(true);
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual([...VERSION_JSON_KEYS].sort());
  }, 30_000);

  it('json_keys_appear_in_stable_sorted_order', async () => {
    // encoding/json sorts map keys alphabetically. The struct fields
    // produce those keys; we assert the textual order matches the
    // alphabetical order so an orchestrator that does substring
    // extraction (rare but legal) sees a stable shape.
    const res = await runHub(['version', '--json']);
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout.trim()) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([...VERSION_JSON_KEYS].sort());
  }, 30_000);

  it('json_hub_value_matches_human_hub_value', async () => {
    const human = await runHub(['version']);
    const json = await runHub(['version', '--json']);
    expect(human.status).toBe(0);
    expect(json.status).toBe(0);
    const humanLine = human.stdout.trimEnd();
    const humanHub = humanLine.split(' ')[1]; // "hub 0.1.0 (go1.27.0)" → 0.1.0
    const parsed = JSON.parse(json.stdout.trim()) as { hub: string };
    expect(parsed.hub).toBe(humanHub);
  }, 30_000);

  it('json_payload_contains_no_bearer_shaped_string', async () => {
    const res = await runHub(['version', '--json']);
    expect(res.status).toBe(0);
    expect(res.stdout).not.toMatch(BEARER_PREFIXED_OPAQUE);
    expect(res.stdout).not.toMatch(HUB_BEARER_ENV_ASSIGNMENT);
    expect(res.stdout).not.toMatch(JWT_TRIPLE_SEGMENT);
  }, 30_000);
});

describe('hub version — failure paths', () => {
  it('unknown_subcommand_exits_two_with_diagnostic_on_stderr', async () => {
    const res = await runHub(['versionally']);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/unknown command/);
    expect(res.stderr).toMatch(/--help/);
  }, 30_000);
});
