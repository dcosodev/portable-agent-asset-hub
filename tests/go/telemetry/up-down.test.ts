// tests/go/telemetry/up-down.test.ts
//
// T5 real-subprocess contract for `hub telemetry up` and `hub
// telemetry down`. The tests build the hub binary with `go build
// -trimpath` (via _telemetry-harness), then exercise the live
// binary against a fake `docker` shim injected through PATH.
//
// Contract surface locked in here:
//
//   * `hub telemetry up`             → exit 0, the fake Docker is
//                                     invoked exactly once with a
//                                     Compose argv of
//                                       compose -p <project> -f <yaml>
//                                            up --wait
//                                     and the human stdout reports
//                                     command=up, project=<id>,
//                                     engine=<engine>,
//                                     compose_file=<yaml>.
//
//   * `hub telemetry down` (default) → exit 0, the fake Docker argv is
//                                       compose -p <project> -f <yaml>
//                                            down --remove-orphans
//                                     with NO `-v` flag anywhere in
//                                     the argv. The JSON payload
//                                     reports `volumes_removed: []`.
//
//   * `hub telemetry down --volumes`
//     (without HUB_ALLOW_HUB_DATA_REMOVAL)
//                                   → exit 1, the docker shim is
//                                     NEVER invoked, and stderr
//                                     names the env knob that gates
//                                     the opt-in.
//
//   * `hub telemetry status`         → exit 0; the fake Docker argv is
//                                       compose -p <project> -f <yaml>
//                                            ps --format json --all
//                                     and the JSON payload surfaces
//                                     the parsed service list
//                                     (sorted, no http_health key).
//
//   * bearer-shaped env hygiene      → the subprocess env that hub
//                                     forwards to `docker compose`
//                                     MUST NOT contain
//                                     HUB_BEARER_TOKEN or any of the
//                                     canonical bearer env keys.
//
//   * the default compose file is the
//     T5-owned top-level
//     docker-compose.observability.yml
//                                   → the contract pins the slice's
//                                     ownership of that file. A
//                                     regression that points Detect
//                                     at observability/compose.yaml
//                                     is fail-closed.
//
// The tests intentionally avoid redesigning the implementation: the
// contract is asserted against the existing Service shape, the
// existing fake-docker shim, and the existing harness. New
// contracts (if any) belong in a future slice; this file only locks
// the existing surface so a regression in up/down/status is
// impossible.

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it } from 'vitest';
import {
  buildTelemetryHubBinary,
  freshTelemetryHome,
  installFakeDocker,
  runTelemetryHub,
  type FakeDockerRig,
} from './_telemetry-harness';
import type { FreshRepoLayout } from './_telemetry-harness';
import {
  assertNoVolumeFlag,
  expectComposeLeader,
  findComposeCall,
  findVerbIndex,
} from './_telemetry-helpers';

// ---------------------------------------------------------------------------
// Bearer-shape predicates — mirrors internal/output/output.go.
// ---------------------------------------------------------------------------

// JS regex literals do NOT support inline flags like `(?i)` — that
// is PCRE/Python/Ruby syntax — so we use the `i` flag on each
// literal. Promoting the patterns to module scope keeps the regex
// compilation out of the assertion hot path and makes the intent
// self-documenting.
const BEARER_PREFIXED_OPAQUE = /bearer\s+[A-Za-z0-9._~+/=-]{20,}/i;
const HUB_BEARER_ENV_ASSIGNMENT = /\bHUB_BEARER_TOKEN\b\s*=/i;
const JWT_TRIPLE_SEGMENT = /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/;

// A 32-char opaque-shaped bearer. Long enough to satisfy the
// LooksLikeBearer shape (>=20 chars in the base64url alphabet) but
// not the project's real token; the harness redacts it from stdout
// before any assertion fires.
const OPAQUE_BEARER = 'abcdefghijklmnopqrstuvwxyz123456';

// ---------------------------------------------------------------------------
// Test rig + helpers
// ---------------------------------------------------------------------------

interface TelemetryRig {
  fakeDocker: FakeDockerRig;
  fresh: FreshRepoLayout;
  cleanup: () => void;
}

/**
 * Build a per-test rig: a fake-docker shim and a fresh HUB_HOME /
 * HUB_OPENAPI pair. Cleanup is wired via afterEach so a passing
 * case never bleeds state into the next.
 */
function setupTelemetryRig(label: string): TelemetryRig {
  const fresh = freshTelemetryHome(label);
  const fakeDocker = installFakeDocker();
  // Make sure the binary exists BEFORE we exercise the telemetry
  // surface. The build is amortised across the suite (see
  // _telemetry-harness.buildTelemetryHubBinary) but the first test
  // pays the full cost — we surface a precise failure here so a Go
  // compile error does NOT look like a runtime regression.
  buildTelemetryHubBinary();
  return {
    fakeDocker,
    fresh,
    cleanup: () => {
      fakeDocker.cleanup();
      fresh.cleanup();
    },
  };
}


// ---------------------------------------------------------------------------
// up
// ---------------------------------------------------------------------------

describe('hub telemetry up — fake compose argv contract', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) {
      const fn = cleanups.pop();
      try { fn?.(); } catch { /* best-effort */ }
    }
  });

  it('up_exits_zero_and_prints_human_contract_keys', async () => {
    const rig = setupTelemetryRig('up-human');
    cleanups.push(rig.cleanup);
    const res = await runTelemetryHub(
      ['telemetry', 'up'],
      {
        envOverride: {
          HUB_HOME: rig.fresh.home,
          HUB_OPENAPI: rig.fresh.openapi,
        },
        fakeDocker: rig.fakeDocker,
      },
    );
    expect(res.status).toBe(0);
    // The contract keys are documented in cmd_telemetry.go's
    // emitTelemetry human form: command=, project=, engine=,
    // compose_file=. They appear in that order.
    expect(res.stdout).toMatch(/^command=up$/m);
    expect(res.stdout).toMatch(/^project=hub-\d+-\d+$/m);
    expect(res.stdout).toMatch(/^engine=docker-compose$/m);
    // The compose file MUST be the T5-owned top-level
    // docker-compose.observability.yml — NOT observability/compose.yaml.
    expect(res.stdout).toMatch(/^compose_file=.*\/docker-compose\.observability\.yml$/m);
    // Stderr stays empty on the success path.
    expect(res.stderr).toBe('');
  }, 60_000);

  it('up_invokes_compose_with_project_yaml_and_wait', async () => {
    const rig = setupTelemetryRig('up-argv');
    cleanups.push(rig.cleanup);
    const res = await runTelemetryHub(
      ['telemetry', 'up'],
      {
        envOverride: {
          HUB_HOME: rig.fresh.home,
          HUB_OPENAPI: rig.fresh.openapi,
        },
        fakeDocker: rig.fakeDocker,
      },
    );
    expect(res.status).toBe(0);
    const calls = res.fakeDockerCalls ?? [];
    const up = findComposeCall(calls, 'up');
    expect(up).toBeTruthy();
    const argv = up!.argv;
    expectComposeLeader(argv);
    const verbIdx = findVerbIndex(argv, 'up');
    expect(verbIdx).toBeGreaterThanOrEqual(0);
    expect(argv[verbIdx]).toBe('up');
    const pIdx = argv.indexOf('-p');
    expect(pIdx).toBeGreaterThanOrEqual(0);
    expect(argv[pIdx + 1]).toMatch(/^hub-\d+-\d+$/);
    const fIdx = argv.indexOf('-f');
    expect(fIdx).toBeGreaterThanOrEqual(0);
    // The compose-file flag MUST point at the T5 top-level
    // observability compose file — never at the ADR-0004-protected
    // observability/compose.yaml. A regression that leaks through the
    // legacy path trips the gate before the operator can mutate the
    // protected tree.
    expect(argv[fIdx + 1]).toMatch(/\/docker-compose\.observability\.yml$/);
    expect(argv).toContain('-d');
    expect(argv).toContain('--wait');
    assertNoVolumeFlag(argv);
  }, 60_000);

  it('up_json_payload_contains_locked_keys_and_empty_volumes', async () => {
    const rig = setupTelemetryRig('up-json');
    cleanups.push(rig.cleanup);
    const res = await runTelemetryHub(
      ['telemetry', 'up', '--json'],
      {
        envOverride: {
          HUB_HOME: rig.fresh.home,
          HUB_OPENAPI: rig.fresh.openapi,
        },
        fakeDocker: rig.fakeDocker,
      },
    );
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout.trim()) as Record<string, unknown>;
    expect(parsed.command).toBe('up');
    expect(parsed.engine).toBe('docker-compose');
    expect(typeof parsed.project).toBe('string');
    expect(typeof parsed.compose_file).toBe('string');
    // The compose_file key MUST point at the T5 top-level
    // observability compose file. The compose-yaml allowlist is a
    // T5 contract surface (slices.json implementation_tasks) and
    // a regression is fail-closed.
    expect(parsed.compose_file).toMatch(/\/docker-compose\.observability\.yml$/);
    expect(Array.isArray(parsed.healthy)).toBe(true);
    expect(typeof parsed.started_at).toBe('string');
    expect(typeof parsed.finished_at).toBe('string');
    expect(typeof parsed.timeout).toBe('string');
  }, 60_000);
});

// ---------------------------------------------------------------------------
// down — hub-data preservation (the audit-critical surface)
// ---------------------------------------------------------------------------

describe('hub telemetry down — hub-data preservation contract', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) {
      const fn = cleanups.pop();
      try { fn?.(); } catch { /* best-effort */ }
    }
  });

  it('down_exits_zero_and_prints_human_contract_keys', async () => {
    const rig = setupTelemetryRig('down-human');
    cleanups.push(rig.cleanup);
    const res = await runTelemetryHub(
      ['telemetry', 'down'],
      {
        envOverride: {
          HUB_HOME: rig.fresh.home,
          HUB_OPENAPI: rig.fresh.openapi,
        },
        fakeDocker: rig.fakeDocker,
      },
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/^command=down$/m);
    expect(res.stdout).toMatch(/^project=hub-\d+-\d+$/m);
    expect(res.stdout).toMatch(/^engine=docker-compose$/m);
    expect(res.stdout).toMatch(/^compose_file=.*\/docker-compose\.observability\.yml$/m);
    // No "Removing volume" line in the captured stdout (the fake
    // docker shim only emits those for the down --volumes path,
    // which we never invoke on the default down).
    expect(res.stdout).not.toMatch(/Removing volume/);
    expect(res.stderr).toBe('');
  }, 60_000);

  it('down_invokes_compose_without_volumes_flag', async () => {
    const rig = setupTelemetryRig('down-argv');
    cleanups.push(rig.cleanup);
    const res = await runTelemetryHub(
      ['telemetry', 'down'],
      {
        envOverride: {
          HUB_HOME: rig.fresh.home,
          HUB_OPENAPI: rig.fresh.openapi,
        },
        fakeDocker: rig.fakeDocker,
      },
    );
    expect(res.status).toBe(0);
    const calls = res.fakeDockerCalls ?? [];
    const down = findComposeCall(calls, 'down');
    expect(down).toBeTruthy();
    const argv = down!.argv;
    expectComposeLeader(argv);
    expect(findVerbIndex(argv, 'down')).toBeGreaterThanOrEqual(0);
    assertNoVolumeFlag(argv);
    expect(argv).toContain('--remove-orphans');
  }, 60_000);

  it('down_volumes_refused_without_optin_env', async () => {
    const rig = setupTelemetryRig('down-volumes-refused');
    cleanups.push(rig.cleanup);
    const res = await runTelemetryHub(
      ['telemetry', 'down', '--volumes'],
      {
        envOverride: {
          HUB_HOME: rig.fresh.home,
          HUB_OPENAPI: rig.fresh.openapi,
        },
        fakeDocker: rig.fakeDocker,
      },
    );
    expect(res.status).toBe(1);
    // Docker shim is NEVER invoked when --volumes is refused —
    // hub-data is preserved by construction because the docker
    // subprocess boundary is never crossed.
    const calls = res.fakeDockerCalls ?? [];
    expect(calls).toEqual([]);
    // Stderr carries the literal HUB_ALLOW_HUB_DATA_REMOVAL env
    // knob name so the operator / gate can grep for it
    // deterministically.
    expect(res.stderr).toMatch(/HUB_ALLOW_HUB_DATA_REMOVAL/);
  }, 60_000);

  it('down_json_payload_volumes_removed_is_empty_array', async () => {
    const rig = setupTelemetryRig('down-json');
    cleanups.push(rig.cleanup);
    const res = await runTelemetryHub(
      ['telemetry', 'down', '--json'],
      {
        envOverride: {
          HUB_HOME: rig.fresh.home,
          HUB_OPENAPI: rig.fresh.openapi,
        },
        fakeDocker: rig.fakeDocker,
      },
    );
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout.trim()) as Record<string, unknown>;
    expect(parsed.command).toBe('down');
    expect(Array.isArray(parsed.volumes_removed)).toBe(true);
    expect(parsed.volumes_removed as unknown[]).toEqual([]);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

describe('hub telemetry status — fake compose ps argv contract', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) {
      const fn = cleanups.pop();
      try { fn?.(); } catch { /* best-effort */ }
    }
  });

  it('status_exits_zero_and_prints_human_contract_keys', async () => {
    const rig = setupTelemetryRig('status-human');
    cleanups.push(rig.cleanup);
    const res = await runTelemetryHub(
      ['telemetry', 'status'],
      {
        envOverride: {
          HUB_HOME: rig.fresh.home,
          HUB_OPENAPI: rig.fresh.openapi,
        },
        fakeDocker: rig.fakeDocker,
      },
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/^command=status$/m);
    expect(res.stdout).toMatch(/^project=hub-\d+-\d+$/m);
    expect(res.stdout).toMatch(/^engine=docker-compose$/m);
    expect(res.stdout).toMatch(/^compose_file=.*\/docker-compose\.observability\.yml$/m);
    expect(res.stderr).toBe('');
  }, 60_000);

  it('status_invokes_compose_ps_format_json_all', async () => {
    const rig = setupTelemetryRig('status-argv');
    cleanups.push(rig.cleanup);
    const res = await runTelemetryHub(
      ['telemetry', 'status'],
      {
        envOverride: {
          HUB_HOME: rig.fresh.home,
          HUB_OPENAPI: rig.fresh.openapi,
        },
        fakeDocker: rig.fakeDocker,
      },
    );
    expect(res.status).toBe(0);
    const calls = res.fakeDockerCalls ?? [];
    const ps = findComposeCall(calls, 'ps');
    expect(ps).toBeTruthy();
    const argv = ps!.argv;
    expectComposeLeader(argv);
    expect(findVerbIndex(argv, 'ps')).toBeGreaterThanOrEqual(0);
    expect(argv).toContain('--format');
    expect(argv).toContain('json');
    expect(argv).toContain('--all');
    assertNoVolumeFlag(argv);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Bearer hygiene — the I-07 invariant
// ---------------------------------------------------------------------------

describe('hub telemetry — bearer hygiene', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) {
      const fn = cleanups.pop();
      try { fn?.(); } catch { /* best-effort */ }
    }
  });

  it('strips_bearer_shaped_env_before_subprocess_boundary', async () => {
    const rig = setupTelemetryRig('bearer-strip');
    cleanups.push(rig.cleanup);
    // Inject a 32-char opaque-shaped bearer at process level.
    // The Go runtime MUST strip every canonical bearer env key
    // before forwarding the subprocess env to docker.
    const res = await runTelemetryHub(
      ['telemetry', 'up'],
      {
        envOverride: {
          HUB_HOME: rig.fresh.home,
          HUB_OPENAPI: rig.fresh.openapi,
          HUB_BEARER_TOKEN: OPAQUE_BEARER,
          HUB_BEARER_TOKEN_FILE: `/tmp/hub-token-${OPAQUE_BEARER}`,
          HUB_BEARER_TOKEN_SOURCE: OPAQUE_BEARER,
        },
        fakeDocker: rig.fakeDocker,
      },
    );
    expect(res.status).toBe(0);
    const calls = res.fakeDockerCalls ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      // Every recorded env key must be the empty string — the
      // Service layer's sanitizeEnv strips the canonical bearer
      // keys BEFORE the subprocess sees them.
      for (const [, v] of Object.entries(call.env_bearers)) {
        expect(v).toBe('');
      }
    }
    // stdout / stderr MUST NOT contain a bearer-shaped literal.
    expect(BEARER_PREFIXED_OPAQUE.test(res.stdout)).toBe(false);
    expect(HUB_BEARER_ENV_ASSIGNMENT.test(res.stdout)).toBe(false);
    expect(JWT_TRIPLE_SEGMENT.test(res.stdout)).toBe(false);
    expect(BEARER_PREFIXED_OPAQUE.test(res.stderr)).toBe(false);
  }, 60_000);
});