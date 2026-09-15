// tests/go/shell/doctor.test.ts
//
// T1 real-subprocess contract for `hub doctor` and `hub doctor --json`.
// The tests build a temp hub binary with `go build -trimpath` (via
// _hub-harness) and assert on the LIVE subprocess output against a
// fresh per-test HUB_HOME. The contract surface locked in here:
//
//   * `hub doctor` (human)                    → exit 0 on a fresh
//                                              worktree, prints
//                                              `status=<...>` followed
//                                              by one line per check.
//   * `hub doctor --json`                     → exit 0, stdout is a
//                                              valid JSON object with
//                                              the locked top-level
//                                              keys (status, checks)
//                                              and per-check locked
//                                              keys (id, name,
//                                              status, message,
//                                              optional detail) —
//                                              in a STABLE order.
//   * `status` value on a fresh temp HOME      → "ok" or "warn"; never
//                                              "fail" because the
//                                              checks are calibrated
//                                              to be tolerant of an
//                                              uninitialised layout.
//   * `home_resolved` is `warn` (not fail)     → the doctor MUST NOT
//                                              fail when HUB_HOME is
//                                              a perfectly valid path
//                                              that simply doesn't
//                                              exist yet; that's the
//                                              "fresh worktree" case.
//   * `openapi_accessible` is `ok`             → as long as the env
//                                              wires HUB_OPENAPI to
//                                              the repo's real spec.
//   * `rest_handshake` is `pending`            → wired in T2, never
//                                              blocks the verdict.
//   * no bearer-shaped string in stdout/
//     stderr                                  → the redactor is the
//                                              single chokepoint.
//   * read-only: doctor must NOT create
//     state/, runtime/, logs/, tokens/        → asserted by listing
//                                              the home directory
//                                              after the invocation.
//   * nonzero handling: setting HUB_HOME
//     to a ".." traversal triggers
//     config_load_failed → exit 2             → the shell stays
//                                              fail-closed on a bad
//                                              input even when the
//                                              operator asked for a
//                                              doctor run.

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { runHub, runHubOnFreshHome, repoOpenAPI } from './_hub-harness';

// The harness already resolves the repo's canonical openapi.yaml
// once at module init (see tests/go/shell/_hub-harness.ts:
// `export { repoOpenAPI }`). Re-exporting it here replaces three
// deep `require('node:path')…` chains that the project's ESM-only
// lint rules forbid; every test that needs the path uses the same
// value the harness already validated at startup.
const REPO_OPENAPI = repoOpenAPI;

interface DoctorCheck {
  id: string;
  name: string;
  status: string;
  message: string;
  detail?: string;
}
interface DoctorReport {
  status: string;
  checks: DoctorCheck[];
}

// Bearer-shape predicates for the inline `not.toMatch` assertions
// in this file. Mirrors `_hub-harness.ts` and `internal/output/
// output.go`. JS regex literals do NOT support inline flags like
// `(?i)` — that is PCRE/Python/Ruby syntax — so we use the `i`
// flag on the RegExp literal here too. Keeping them as named
// constants avoids recompiling on every assertion and makes the
// intent self-documenting.
const BEARER_PREFIXED_OPAQUE = /bearer\s+[A-Za-z0-9._~+/=-]{20,}/i;
const HUB_BEARER_ENV_ASSIGNMENT = /\bHUB_BEARER_TOKEN\b\s*=/i;
const HUB_BEARER_RAW_VALUE = /bearer\s+abcdef/i;
const JWT_TRIPLE_SEGMENT = /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/;

const KNOWN_CHECK_IDS = [
  'shell_binary',
  'config_valid',
  'home_resolved',
  'openapi_accessible',
  'no_bearer_in_env',
  'rest_handshake',
];
const KNOWN_TOP_KEYS = ['checks', 'status'];
const KNOWN_CHECK_KEYS = ['id', 'message', 'name', 'status'];

describe('hub doctor — fresh worktree (human-readable)', () => {
  // Each test gets a fresh HOME so a passing case never bleeds
  // state into the next. The cleanup hooks are local to the
  // describe so the suite is hermetic.
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) {
      const fn = cleanups.pop();
      try { fn?.(); } catch { /* best-effort */ }
    }
  });

  it('exits_zero_on_a_fresh_temp_home', async () => {
    const res = await runHubOnFreshHome(['doctor'], { label: 'fresh-ok' });
    cleanups.push(res.cleanup);
    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
  }, 30_000);

  it('first_line_is_status_key_equals', async () => {
    const res = await runHubOnFreshHome(['doctor'], { label: 'first-line' });
    cleanups.push(res.cleanup);
    expect(res.status).toBe(0);
    const firstLine = res.stdout.split('\n')[0];
    // Either "status=ok" or "status=warn" — NEVER "fail" on a
    // fresh worktree, NEVER "pending" (pending checks are filtered
    // from the top-level verdict).
    expect(firstLine).toMatch(/^status=(ok|warn)$/);
  }, 30_000);

  it('every_known_check_id_appears_in_human_output', async () => {
    const res = await runHubOnFreshHome(['doctor'], { label: 'human-checks' });
    cleanups.push(res.cleanup);
    expect(res.status).toBe(0);
    for (const id of KNOWN_CHECK_IDS) {
      // The human output is `<indent>[<status>] <id>: <name> — …`
      // so we anchor on the bracketed-status + id pattern.
      const re = new RegExp(`\\[\\w+\\] ${id}:`);
      expect(res.stdout).toMatch(re);
    }
  }, 30_000);

  it('human_output_contains_no_bearer_shaped_string', async () => {
    const res = await runHubOnFreshHome(['doctor'], { label: 'human-bearer' });
    cleanups.push(res.cleanup);
    expect(res.status).toBe(0);
    expect(res.stdout).not.toMatch(BEARER_PREFIXED_OPAQUE);
    expect(res.stdout).not.toMatch(HUB_BEARER_ENV_ASSIGNMENT);
    expect(res.stdout).not.toMatch(JWT_TRIPLE_SEGMENT);
  }, 30_000);

  it('is_read_only_no_layout_subdirs_created', async () => {
    const res = await runHubOnFreshHome(['doctor'], { label: 'read-only' });
    cleanups.push(res.cleanup);
    expect(res.status).toBe(0);
    // The doctor MUST NOT create state/, runtime/, logs/, tokens/.
    // Those are reserved for `hub init` and the doctor explicitly
    // promises "never mutates the filesystem" in
    // internal/doctor/doctor.go.
    expect(existsSync(res.home)).toBe(true);
    const entries = readdirSync(res.home);
    expect(entries).toEqual([]);
  }, 30_000);

  it('home_resolved_is_warn_not_fail_on_missing_dir', async () => {
    // The doctor MUST report `home_resolved` as warn (operator sees
    // "run hub init"), NOT fail, when HUB_HOME is a perfectly valid
    // path that simply does not exist on disk yet — that is the
    // "fresh worktree" case. Otherwise the exit criteria
    // ("doctor reports OK on a fresh worktree") regresses.
    //
    // The harness's `runHubOnFreshHome` helper creates the temp
    // dir BEFORE the subprocess spawns (via mkdtempSync), so a
    // naïve call would see HOME on disk and return [ok] home_resolved.
    // To genuinely exercise warn-not-fail we pass a non-existent
    // HUB_HOME path directly through runHub. The path is the
    // canonical `/tmp/hub-no-such-dir-<pid>-<ts>` shape so two
    // concurrent runs never collide.
    const res = await runHub(
      ['doctor'],
      {
        HUB_HOME: `/tmp/hub-no-such-dir-${process.pid}-${Date.now()}`,
        HUB_OPENAPI: REPO_OPENAPI,
      },
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/\[warn\] home_resolved:/);
    expect(res.stdout).not.toMatch(/\[fail\] home_resolved:/);
  }, 30_000);
});

describe('hub doctor --json — structured contract', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) {
      const fn = cleanups.pop();
      try { fn?.(); } catch { /* best-effort */ }
    }
  });

  it('exits_zero_and_emits_valid_json_object', async () => {
    const res = await runHubOnFreshHome(['doctor', '--json'], { label: 'json-ok' });
    cleanups.push(res.cleanup);
    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
    const trimmed = res.stdout.trim();
    expect(trimmed.startsWith('{')).toBe(true);
    expect(trimmed.endsWith('}')).toBe(true);
    // Throws on bad JSON — the assertion IS the parse.
    const parsed = JSON.parse(trimmed) as DoctorReport;
    expect(parsed).toBeTruthy();
  }, 30_000);

  it('top_level_keys_are_status_and_checks_in_stable_order', async () => {
    const res = await runHubOnFreshHome(['doctor', '--json'], { label: 'top-keys' });
    cleanups.push(res.cleanup);
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout.trim()) as DoctorReport;
    // The struct tag is `status` then `checks`; encoding/json
    // preserves struct order. The test asserts the locked order
    // (status first, checks second) so any future field added in
    // between trips the gate.
    expect(Object.keys(parsed)).toEqual([...KNOWN_TOP_KEYS]);
  }, 30_000);

  it('top_level_status_is_ok_or_warn_never_fail_or_pending', async () => {
    const res = await runHubOnFreshHome(['doctor', '--json'], { label: 'top-status' });
    cleanups.push(res.cleanup);
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout.trim()) as DoctorReport;
    expect(['ok', 'warn']).toContain(parsed.status);
    expect(parsed.status).not.toBe('fail');
    expect(parsed.status).not.toBe('pending');
  }, 30_000);

  it('every_locked_check_id_is_present_in_deterministic_order', async () => {
    const res = await runHubOnFreshHome(['doctor', '--json'], { label: 'check-ids' });
    cleanups.push(res.cleanup);
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout.trim()) as DoctorReport;
    expect(parsed.checks.map((c) => c.id)).toEqual(KNOWN_CHECK_IDS);
  }, 30_000);

  it('every_check_has_exactly_the_locked_keys', async () => {
    const res = await runHubOnFreshHome(['doctor', '--json'], { label: 'check-keys' });
    cleanups.push(res.cleanup);
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout.trim()) as DoctorReport;
    for (const c of parsed.checks) {
      // `detail` is omitempty — if absent, the key set is the four
      // mandatory ones; if present, it must be the fifth and last.
      const keys = Object.keys(c).sort();
      const expected = [...KNOWN_CHECK_KEYS].sort();
      // detail (when present) must sort AFTER status alphabetically,
      // but omitempty makes it absent on most checks. We allow both
      // shapes explicitly.
      const withDetail = [...KNOWN_CHECK_KEYS, 'detail'].sort();
      const ok = JSON.stringify(keys) === JSON.stringify(expected)
        || JSON.stringify(keys) === JSON.stringify(withDetail);
      expect(ok).toBe(true);
    }
  }, 30_000);

  it('rest_handshake_is_pending_and_does_not_block_verdict', async () => {
    const res = await runHubOnFreshHome(['doctor', '--json'], { label: 'rest-pending' });
    cleanups.push(res.cleanup);
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout.trim()) as DoctorReport;
    const rest = parsed.checks.find((c) => c.id === 'rest_handshake');
    expect(rest).toBeTruthy();
    expect(rest?.status).toBe('pending');
    // The top-level verdict must NOT be "pending" — pending checks
    // are filtered out of the aggregation.
    expect(parsed.status).not.toBe('pending');
  }, 30_000);

  it('two_consecutive_invocations_produce_byte_exact_json', async () => {
    // The doctor JSON payload is the orchestrator contract surface.
    // Two consecutive invocations on the same fresh HOME must
    // produce identical bytes (no timestamps, no random IDs).
    const a = await runHubOnFreshHome(['doctor', '--json'], { label: 'det-a' });
    const b = await runHubOnFreshHome(['doctor', '--json'], { label: 'det-b' });
    cleanups.push(a.cleanup);
    cleanups.push(b.cleanup);
    expect(a.status).toBe(0);
    expect(b.status).toBe(0);
    expect(a.stdout).toBe(b.stdout);
    // sanity: the resolved HOME differs but the payload is identical.
    expect(a.home).not.toBe(b.home);
  }, 30_000);

  it('json_payload_contains_no_bearer_shaped_string', async () => {
    const res = await runHubOnFreshHome(['doctor', '--json'], { label: 'json-bearer' });
    cleanups.push(res.cleanup);
    expect(res.status).toBe(0);
    expect(res.stdout).not.toMatch(BEARER_PREFIXED_OPAQUE);
    expect(res.stdout).not.toMatch(HUB_BEARER_ENV_ASSIGNMENT);
    expect(res.stdout).not.toMatch(JWT_TRIPLE_SEGMENT);
  }, 30_000);
});

describe('hub doctor — bearer hygiene when an env var carries a bearer-shaped value', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) {
      const fn = cleanups.pop();
      try { fn?.(); } catch { /* best-effort */ }
    }
  });

  it('no_bearer_in_env_check_warns_when_HUB_BEARER_TOKEN_set', async () => {
    // A long opaque token that triggers LooksLikeBearer. The doctor
    // surfaces the env-var NAME in the warning, never the value.
    const res = await runHubOnFreshHome(['doctor', '--json'], {
      label: 'bearer-env',
    });
    cleanups.push(res.cleanup);
    const homeRes = await runHubOnFreshHome(['doctor', '--json'], { label: 'bearer-rehome' });
    cleanups.push(homeRes.cleanup);
    // Inject a bearer-shaped value AFTER runHubOnFreshHome wires
    // the rest of the env. We re-run with the override layered on
    // top of the harness's cleaned env by going through runHub().
    const env = {
      HUB_OPENAPI: REPO_OPENAPI,
      HUB_BEARER_TOKEN: 'abcdefghijklmnopqrstuvwxyz123456',
    };
    const bearerRes = await runHub(['doctor', '--json'], { ...env, HUB_HOME: homeRes.home });
    expect(bearerRes.status).toBe(0);
    const parsed = JSON.parse(bearerRes.stdout.trim()) as DoctorReport;
    const noBearer = parsed.checks.find((c) => c.id === 'no_bearer_in_env');
    expect(noBearer).toBeTruthy();
    expect(noBearer?.status).toBe('warn');
    // The raw bearer value MUST NEVER appear in the redacted
    // payload — only the env-var name. We assert the substring is
    // absent from BOTH stdout and stderr to cover both surfaces.
    expect(bearerRes.stdout).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
    expect(bearerRes.stderr).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
    // And the explicit redactor marker may be present (the JSON
    // redaction path inserts <<REDACTED>>), but only via the
    // documented marker — never the raw token.
    expect(bearerRes.stdout).not.toMatch(HUB_BEARER_RAW_VALUE);
  }, 30_000);
});

describe('hub doctor — nonzero handling on bad input', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) {
      const fn = cleanups.pop();
      try { fn?.(); } catch { /* best-effort */ }
    }
  });

  it('parent_traversal_in_HUB_HOME_is_rejected_with_exit_two', async () => {
    // The shell is fail-closed: a `..` segment in HUB_HOME triggers
    // config_load_failed, which is surfaced as exit 2 (contract
    // violation). The doctor never even runs in that case — the
    // contract is "doctor on a valid input".
    const res = await runHub(
      ['doctor'],
      {
        HUB_HOME: '/tmp/../etc/passwd',
        HUB_OPENAPI: REPO_OPENAPI,
      },
    );
    expect(res.status).toBe(2);
    // Diagnostic on stderr explains why the contract was violated;
    // stdout stays empty so a CI pipeline that pipes stdout does
    // not see misleading doctor output.
    expect(res.stderr).toMatch(/config:/);
    expect(res.stdout).toBe('');
  }, 30_000);
});
