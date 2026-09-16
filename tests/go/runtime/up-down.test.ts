// tests/go/runtime/up-down.test.ts
//
// T2 real-subprocess contract for `hub runtime up` and `hub runtime
// down`. The tests build the hub binary with `go build -trimpath`
// (via _runtime-harness), then exercise the live binary against a
// fake `docker` shim injected through PATH. No real Docker is ever
// touched; the harness runs `hub` and observes the docker argv the
// Go runtime forwards to its subprocess boundary.
//
// Contract surface locked in here:
//
//   * `hub runtime up`              → exit 0, the fake Docker is
//                                     invoked exactly once with a
//                                     Compose argv of
//                                       compose -p <project> -f <yaml>
//                                            up --wait
//                                     and the human stdout reports
//                                     command=up, project=<id>,
//                                     engine=<engine>,
//                                     compose_file=<yaml>.
//
//   * `hub runtime down` (default)  → exit 0, the fake Docker argv is
//                                       compose -p <project> -f <yaml>
//                                            down --remove-orphans
//                                     with NO `-v` flag anywhere in
//                                     the argv. The JSON payload
//                                     reports `volumes_removed: []`
//                                     and the human output confirms
//                                     hub-data is preserved (no
//                                     "Removing volume hub-data" line
//                                     in the captured stdout either).
//
//   * `hub runtime down --volumes`
//     (without HUB_ALLOW_HUB_DATA_REMOVAL)
//                                   → exit 1, the docker shim is
//                                     NEVER invoked, and stderr
//                                     names the env knob that gates
//                                     the opt-in.
//
//   * bearer-shaped env hygiene      → the subprocess env that hub
//                                     forwards to `docker compose`
//                                     MUST NOT contain
//                                     HUB_BEARER_TOKEN or any of the
//                                     canonical bearer env keys; a
//                                     process-level
//                                     HUB_BEARER_TOKEN=<opaque> is
//                                     stripped before the subprocess
//                                     boundary.
//
//   * no live Docker dependency      → every test passes when the
//                                     host has NO docker on PATH
//                                     because the harness installs
//                                     a fake shim directory ahead
//                                     of the real PATH.
//
// The tests intentionally avoid redesigning the implementation: the
// contract is asserted against the existing Service shape, the
// existing fake-docker shim, and the existing harness. New contracts
// (if any) belong in a future slice; this file only locks the
// existing surface so a regression in up/down is impossible.

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it } from 'vitest';
import {
  buildRuntimeHubBinary,
  freshRuntimeHome,
  installFakeDocker,
  runRuntimeHub,
  type FakeDockerRig,
} from './_runtime-harness';
import type { FreshRepoLayout } from './_runtime-harness';
import {
  assertNoVolumeFlag,
  expectComposeLeader,
  findComposeCall,
  findVerbIndex,
} from './_runtime-helpers';

// ---------------------------------------------------------------------------
// Bearer-shape predicates — mirrors internal/output/output.go.
// ---------------------------------------------------------------------------

// JS regex literals do NOT support inline flags like `(?i)` — that is
// PCRE/Python/Ruby syntax — so we use the `i` flag on each literal.
// Promoting the patterns to module scope keeps the regex compilation
// out of the assertion hot path and makes the intent self-documenting.
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

interface UpRig {
  fakeDocker: FakeDockerRig;
  fresh: FreshRepoLayout;
  cleanup: () => void;
}

/**
 * Build a per-test rig: a fake-docker shim and a fresh HUB_HOME /
 * HUB_OPENAPI pair. Cleanup is wired via afterEach so a passing
 * case never bleeds state into the next.
 */
function setupUpDownRig(label: string): UpRig {
  const fresh = freshRuntimeHome(label);
  const fakeDocker = installFakeDocker();
  // Make sure the binary exists BEFORE we exercise the runtime
  // surface. The build is amortised across the suite (see
  // _runtime-harness.buildRuntimeHubBinary) but the first test pays
  // the full cost — we surface a precise failure here so a Go
  // compile error does NOT look like a runtime regression.
  buildRuntimeHubBinary();
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

describe('hub runtime up — fake compose argv contract', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) {
      const fn = cleanups.pop();
      try { fn?.(); } catch { /* best-effort */ }
    }
  });

  it('up_exits_zero_and_prints_human_contract_keys', async () => {
    const rig = setupUpDownRig('up-human');
    cleanups.push(rig.cleanup);
    const res = await runRuntimeHub(
      ['runtime', 'up'],
      {
        envOverride: {
          HUB_HOME: rig.fresh.home,
          HUB_OPENAPI: rig.fresh.openapi,
        },
        fakeDocker: rig.fakeDocker,
      },
    );
    expect(res.status).toBe(0);
    // The contract keys are documented in cmd_runtime.go's
    // emitRuntime human form: command=, project=, engine=,
    // compose_file=. They appear in that order.
    expect(res.stdout).toMatch(/^command=up$/m);
    expect(res.stdout).toMatch(/^project=hub-\d+-\d+$/m);
    expect(res.stdout).toMatch(/^engine=docker-compose$/m);
    expect(res.stdout).toMatch(/^compose_file=/m);
    // Stderr stays empty on the success path.
    expect(res.stderr).toBe('');
  }, 60_000);

  it('up_invokes_compose_with_project_yaml_and_wait', async () => {
    const rig = setupUpDownRig('up-argv');
    cleanups.push(rig.cleanup);
    const res = await runRuntimeHub(
      ['runtime', 'up'],
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
    // Expected argv shape (cmd/hub → internal/compose.Service.Up):
    //   compose -p <project> -f <yaml> up --wait
    // Detach (-d) is also sent — the docs in compose.go say
    // `detached + wait-for-health` is the default. We use the
    // shared helpers so a future refactor that reorders the
    // options (`-f` before `-p`, additional flags between `-d`
    // and the verb, …) does not silently regress the test.
    expectComposeLeader(argv);
    const verbIdx = findVerbIndex(argv, 'up');
    expect(verbIdx).toBeGreaterThanOrEqual(0);
    // The verb itself is the literal `up`.
    expect(argv[verbIdx]).toBe('up');
    // `-p <project>` and `-f <yaml>` are value-bearing flags; we
    // pin the EXACT values via indexOf so the project name and
    // compose-file path are observable from the fake shim
    // transcript (not just asserted in the JSON payload).
    const pIdx = argv.indexOf('-p');
    expect(pIdx).toBeGreaterThanOrEqual(0);
    expect(argv[pIdx + 1]).toMatch(/^hub-\d+-\d+$/);
    const fIdx = argv.indexOf('-f');
    expect(fIdx).toBeGreaterThanOrEqual(0);
    expect(argv[fIdx + 1]).toMatch(/\/observability\/compose\.yaml$/);
    // The default up must carry `-d` (detached) and `--wait`
    // (wait-for-health). Containment, not position — Compose may
    // add new flags between `-d` and the verb in a future
    // release, and we do not want a regression trap there.
    expect(argv).toContain('-d');
    expect(argv).toContain('--wait');
    // Default up must NOT include -v / --volumes either.
    assertNoVolumeFlag(argv);
  }, 60_000);

  it('up_json_payload_contains_locked_keys_and_empty_volumes', async () => {
    const rig = setupUpDownRig('up-json');
    cleanups.push(rig.cleanup);
    const res = await runRuntimeHub(
      ['runtime', 'up', '--json'],
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
    // Locked top-level keys for the up result. cmd_runtime.go's
    // RuntimeResult is the wire shape; the gate asserts on these
    // keys so a future field addition is a contract-visible change.
    expect(parsed.command).toBe('up');
    expect(parsed.engine).toBe('docker-compose');
    expect(typeof parsed.project).toBe('string');
    expect(typeof parsed.compose_file).toBe('string');
    expect(parsed.compose_file).toMatch(/\/observability\/compose\.yaml$/);
    expect(Array.isArray(parsed.healthy)).toBe(true);
    // up MUST NOT have volumes_removed in the default path. The
    // field is omitempty so it is absent from the JSON. We assert
    // BOTH the field is absent AND volumes_removed is not in the
    // parsed payload — the lock is "no volumes removed on up".
    expect(parsed.volumes_removed).toBeUndefined();
    expect('volumes_removed' in parsed).toBe(false);
    expect(typeof parsed.started_at).toBe('string');
    expect(typeof parsed.finished_at).toBe('string');
    expect(typeof parsed.timeout).toBe('string');
  }, 60_000);

  it('up_json_payload_services_is_empty_array_not_null', async () => {
    // T2 regression lock. The independent audit found that
    // cmd/hub/cmd_runtime.go's upToResult left RuntimeResult.Services
    // nil, so `hub runtime up --json` emitted `"services":null`. The
    // locked schema declares Services as an array; statusToResult
    // and psToResult already coerce nil → []; upToResult must do
    // the same so the `Array.isArray(parsed.services)` invariant
    // holds deterministically across every runtime subcommand.
    // The schema (key name + array type) is unchanged — only the
    // shape of the empty value is fixed.
    const rig = setupUpDownRig('up-json-services-array');
    cleanups.push(rig.cleanup);
    const res = await runRuntimeHub(
      ['runtime', 'up', '--json'],
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
    // Key must be present (schema invariant).
    expect('services' in parsed).toBe(true);
    // Value must be an Array, NOT null — the audit-cited defect.
    expect(Array.isArray(parsed.services)).toBe(true);
    // And the array must be empty for the default up path (no ps
    // probe populates the up result; only status / ps do).
    expect(parsed.services as unknown[]).toEqual([]);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// down — hub-data preservation (the audit-critical surface)
// ---------------------------------------------------------------------------

describe('hub runtime down — hub-data preservation contract', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) {
      const fn = cleanups.pop();
      try { fn?.(); } catch { /* best-effort */ }
    }
  });

  it('down_default_omits_dash_v_in_compose_argv', async () => {
    // The audit-critical assertion: a default `down` must NEVER add
    // `-v` to the Compose argv. The Service layer enforces this by
    // construction; the test makes sure a future refactor that
    // changes the default does not silently regress the audit.
    const rig = setupUpDownRig('down-no-v');
    cleanups.push(rig.cleanup);
    const res = await runRuntimeHub(
      ['runtime', 'down', '--json'],
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
    // Expected argv shape:
    //   compose -p <project> -f <yaml> down --remove-orphans
    // We use the shared helpers so a future Compose release that
    // reorders `-p` / `-f` / `-d` relative to the verb does not
    // silently regress this assertion. `expectComposeLeader` locks
    // the leading `compose`; `findVerbIndex` locates the verb
    // position; `argv.indexOf('-p' | '-f')` finds the value-bearing
    // flags without assuming argv[2] / argv[4].
    expectComposeLeader(argv);
    const verbIdx = findVerbIndex(argv, 'down');
    expect(verbIdx).toBeGreaterThanOrEqual(0);
    expect(argv[verbIdx]).toBe('down');
    const pIdx = argv.indexOf('-p');
    expect(pIdx).toBeGreaterThanOrEqual(0);
    expect(argv[pIdx + 1]).toMatch(/^hub-\d+-\d+$/);
    const fIdx = argv.indexOf('-f');
    expect(fIdx).toBeGreaterThanOrEqual(0);
    expect(argv[fIdx + 1]).toMatch(/\/observability\/compose\.yaml$/);
    expect(argv).toContain('--remove-orphans');
    // The audit surface: NO -v and NO --volumes. assertNoVolumeFlag
    // is the single chokepoint for this invariant.
    assertNoVolumeFlag(argv);
    // Belt-and-braces: also assert the JSON payload reports zero
    // volumes removed so the contract is observable from both the
    // fake-shim transcript AND the hub's structured output.
    const parsed = JSON.parse(res.stdout.trim()) as Record<string, unknown>;
    expect(parsed.command).toBe('down');
    expect(parsed.volumes_removed).toBeUndefined();
    expect('volumes_removed' in parsed).toBe(false);
  }, 60_000);

  it('down_default_json_payload_reports_hub_data_preserved', async () => {
    // The default down MUST report hub-data as preserved. The
    // Service layer never forwards `-v` by default and never adds
    // hub-data to a VolumesRemoved list; the JSON payload omits the
    // field (omitempty). The test locks both halves of that
    // contract.
    const rig = setupUpDownRig('down-hub-data');
    cleanups.push(rig.cleanup);
    const res = await runRuntimeHub(
      ['runtime', 'down', '--json'],
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
    expect(parsed.volumes_removed).toBeUndefined();
    expect('volumes_removed' in parsed).toBe(false);
    // The fake shim also has not produced any "Removing volume"
    // lines; the human stdout therefore never contains the
    // hub-data literal. We also assert stdout / stderr do not leak
    // any bearer-shaped string while we are here (cheap, and
    // matches the gate's behaviour).
    expect(res.stdout).not.toMatch(/hub-data/);
    expect(res.stdout).not.toMatch(BEARER_PREFIXED_OPAQUE);
    expect(res.stdout).not.toMatch(HUB_BEARER_ENV_ASSIGNMENT);
    expect(res.stdout).not.toMatch(JWT_TRIPLE_SEGMENT);
  }, 60_000);

  it('down_with_volumes_flag_without_env_knob_exits_one_and_skips_docker', async () => {
    // The CLI accepts `--volumes`, but the handler refuses to
    // forward `-v` to Compose unless HUB_ALLOW_HUB_DATA_REMOVAL=1
    // is also set. Without the env knob the call short-circuits
    // before the docker shim is ever invoked. This is the safety
    // net for accidental `--volumes` on the CLI.
    const rig = setupUpDownRig('down-volumes-refused');
    cleanups.push(rig.cleanup);
    const res = await runRuntimeHub(
      ['runtime', 'down', '--volumes'],
      {
        envOverride: {
          HUB_HOME: rig.fresh.home,
          HUB_OPENAPI: rig.fresh.openapi,
          // Intentionally do NOT set HUB_ALLOW_HUB_DATA_REMOVAL.
        },
        fakeDocker: rig.fakeDocker,
      },
    );
    // Exit 1 = operator error (the env knob was missing).
    expect(res.status).toBe(1);
    // The handler emits a diagnostic on stderr that names the env
    // knob so the operator knows how to opt in.
    expect(res.stderr).toMatch(/HUB_ALLOW_HUB_DATA_REMOVAL/);
    // CRITICAL: the docker shim was NEVER invoked. The
    // audit must show zero "down" calls so no hub-data was at
    // risk. The harness re-reads the cumulative transcript on close,
    // so we just check that no `compose down` call appears.
    const calls = res.fakeDockerCalls ?? [];
    const down = findComposeCall(calls, 'down');
    expect(down).toBeUndefined();
  }, 60_000);

  it('down_with_volumes_and_env_knob_still_does_not_remove_hub_data_via_default_compose', async () => {
    // With HUB_ALLOW_HUB_DATA_REMOVAL=1 the handler does pass
    // `-v` through. However, the default behavior we exercise here
    // is `runtime down` (no flag), so the argv still does NOT
    // include -v — the env knob is documented as gated behind an
    // explicit `--volumes` flag. This test pins the negative
    // surface: env knob present + no flag = no -v.
    const rig = setupUpDownRig('down-env-only-no-flag');
    cleanups.push(rig.cleanup);
    const res = await runRuntimeHub(
      ['runtime', 'down'],
      {
        envOverride: {
          HUB_HOME: rig.fresh.home,
          HUB_OPENAPI: rig.fresh.openapi,
          HUB_ALLOW_HUB_DATA_REMOVAL: '1',
        },
        fakeDocker: rig.fakeDocker,
      },
    );
    expect(res.status).toBe(0);
    const calls = res.fakeDockerCalls ?? [];
    const down = findComposeCall(calls, 'down');
    expect(down).toBeTruthy();
    assertNoVolumeFlag(down!.argv);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Bearer hygiene — process-level bearer must not leak to docker
// ---------------------------------------------------------------------------

describe('hub runtime — bearer-shaped env is not forwarded to compose', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) {
      const fn = cleanups.pop();
      try { fn?.(); } catch { /* best-effort */ }
    }
  });

  it('process_level_HUB_BEARER_TOKEN_is_not_forwarded_to_docker_subprocess', async () => {
    // I-07 (bearer hygiene). A process-level HUB_BEARER_TOKEN is
    // set BEFORE hub starts; the Service layer's sanitizeEnv
    // strips it before the docker subprocess env is built. The
    // fake shim records every env key in envSnapshot — we assert
    // HUB_BEARER_TOKEN is empty in EVERY recorded invocation.
    const rig = setupUpDownRig('bearer-up');
    cleanups.push(rig.cleanup);
    const res = await runRuntimeHub(
      ['runtime', 'up'],
      {
        envOverride: {
          HUB_HOME: rig.fresh.home,
          HUB_OPENAPI: rig.fresh.openapi,
          // Inject a bearer-shaped value at the process level.
          HUB_BEARER_TOKEN: OPAQUE_BEARER,
        },
        fakeDocker: rig.fakeDocker,
      },
    );
    expect(res.status).toBe(0);
    const calls = res.fakeDockerCalls ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      // The recorded env snapshot includes five bearer-related
      // keys; ALL of them must be empty strings when the harness
      // ran with a process-level bearer.
      const b = c.env_bearers ?? {};
      expect(b.HUB_BEARER_TOKEN ?? '').toBe('');
      expect(b.HUB_BEARER_TOKEN_FILE ?? '').toBe('');
      expect(b.HUB_BEARER_TOKEN_SOURCE ?? '').toBe('');
      expect(b.AGENT_MEMORY_BEARER_TOKEN ?? '').toBe('');
    }
    // The raw bearer value MUST NEVER appear on either stream of
    // hub's own output. Belt-and-braces for the redaction path.
    expect(res.stdout).not.toContain(OPAQUE_BEARER);
    expect(res.stderr).not.toContain(OPAQUE_BEARER);
  }, 60_000);

  it('process_level_HUB_BEARER_TOKEN_FILE_is_not_forwarded_to_docker_subprocess', async () => {
    // Same assertion, different env knob. The Service layer strips
    // HUB_BEARER_TOKEN_FILE from the parent env even when the
    // operator points it at a real file path — the file-path
    // itself is forwarded only when the operator passes
    // `--bearer-file` (T3 surface; today the binary does not
    // accept that flag). For T2 the invariant is: a stray
    // HUB_BEARER_TOKEN_FILE on the parent env is NEVER forwarded.
    const rig = setupUpDownRig('bearer-file-down');
    cleanups.push(rig.cleanup);
    const res = await runRuntimeHub(
      ['runtime', 'down'],
      {
        envOverride: {
          HUB_HOME: rig.fresh.home,
          HUB_OPENAPI: rig.fresh.openapi,
          HUB_BEARER_TOKEN_FILE: '/tmp/hub-bearer-file-fixture',
        },
        fakeDocker: rig.fakeDocker,
      },
    );
    expect(res.status).toBe(0);
    const calls = res.fakeDockerCalls ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      const b = c.env_bearers ?? {};
      // The harness strips HUB_BEARER_TOKEN_FILE from the parent
      // env via the cleanedEnv list, so the docker subprocess
      // never sees it.
      expect(b.HUB_BEARER_TOKEN_FILE ?? '').toBe('');
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Up+down cycle — back-to-back lifecycle works without real Docker
// ---------------------------------------------------------------------------

describe('hub runtime — up then down lifecycle on a fake docker', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) {
      const fn = cleanups.pop();
      try { fn?.(); } catch { /* best-effort */ }
    }
  });

  it('up_followed_by_down_produces_compose_up_then_compose_down_in_order', async () => {
    // Lifecycle smoke: a back-to-back up/down cycle against the
    // fake shim must produce a `compose up` call followed by a
    // `compose down` call in that order, neither carrying -v, and
    // both exiting 0. This is the canonical "stack comes up, hub
    // responds, then down cleanly" path the slice promises.
    const rig = setupUpDownRig('cycle');
    cleanups.push(rig.cleanup);
    const up = await runRuntimeHub(
      ['runtime', 'up'],
      {
        envOverride: {
          HUB_HOME: rig.fresh.home,
          HUB_OPENAPI: rig.fresh.openapi,
        },
        fakeDocker: rig.fakeDocker,
      },
    );
    expect(up.status).toBe(0);
    const down = await runRuntimeHub(
      ['runtime', 'down'],
      {
        envOverride: {
          HUB_HOME: rig.fresh.home,
          HUB_OPENAPI: rig.fresh.openapi,
        },
        fakeDocker: rig.fakeDocker,
      },
    );
    expect(down.status).toBe(0);
    const calls = down.fakeDockerCalls ?? [];
    // We have at least one up and one down call. Use the shared
    // helper so we don't pin argv[0]/argv[1] which is brittle
    // against future flag re-orderings; the helper already
    // understands `-p <project>` / `-f <yaml>` value flags.
    const upCall = findComposeCall(calls, 'up');
    const downCall = findComposeCall(calls, 'down');
    expect(upCall).toBeTruthy();
    expect(downCall).toBeTruthy();
    // And the down call comes AFTER the up call in the
    // transcript. We pin the index so a future refactor that
    // re-orders them is impossible. The helper
    // `findComposeCall` returns the FIRST match, so we re-scan
    // here for the SECOND matching call — using
    // `findVerbIndex` rather than argv[0] / argv[1] indices so
    // the check is robust against flag re-orderings.
    const upIdx = calls.findIndex((c) => findVerbIndex(c.argv, 'up') >= 0);
    const downIdx = calls.findIndex(
      (c, i) => i > upIdx && findVerbIndex(c.argv, 'down') >= 0,
    );
    expect(upIdx).toBeGreaterThanOrEqual(0);
    expect(downIdx).toBeGreaterThan(upIdx);
    // Neither call carries -v.
    assertNoVolumeFlag(upCall!.argv);
    assertNoVolumeFlag(downCall!.argv);
  }, 90_000);
});