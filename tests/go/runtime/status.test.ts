// tests/go/runtime/status.test.ts
//
// T2 real-subprocess contract for `hub runtime status`, `hub runtime
// ps`, and `hub runtime logs`. The tests build the hub binary with
// `go build -trimpath` (via _runtime-harness), then exercise the
// live binary against a fake `docker` shim injected through PATH.
// No real Docker is ever touched; the harness installs a fake
// shim directory ahead of the real PATH so even a CI worker that
// does NOT have docker installed passes every assertion.
//
// Hermetic guarantees (mirror up-down.test.ts):
//   * The hub binary is written under os.tmpdir()/hub-runtime-<pid>-<ts>/.
//   * A fake `docker` shim is installed in a per-run PATH-prepended
//     directory. The shim records every invocation (argv + env
//     snapshot) into a JSONL transcript and emits the canned ps /
//     logs payloads the test wrote into the rig's scratch dir.
//   * The `--health-url` probe (loopback-first, I-10) targets a
//     real `http.createServer` bound to 127.0.0.1, NOT a public
//     address — we never depend on `0.0.0.0` / external services.
//   * HUB_HOME / HUB_RUNTIME / HUB_OPENAPI are pointed at hermetic
//     per-test temp paths so the binary never sees the operator's
//     state.
//
// Contract surface locked in this file:
//
//   * `hub runtime status`            → exit 0; the fake Docker is
//                                       invoked exactly once with
//                                         compose -p <project>
//                                                -f <yaml>
//                                                ps --format json --all
//                                       and stdout reports
//                                       command=status,
//                                       project=<isolated id>,
//                                       engine=docker-compose,
//                                       compose_file=<yaml>.
//
//   * `hub runtime status --json`     → exit 0; payload is a JSON
//                                       object with locked keys
//                                       {command, project, engine,
//                                        compose_file, healthy,
//                                        services, http_health
//                                        (only when --health-url
//                                        is set), started_at,
//                                        finished_at, timeout}. The
//                                       services array, when
//                                       populated, is sorted by
//                                       Name (so two consecutive
//                                       runs produce byte-identical
//                                       JSON).
//
//   * `hub runtime status --health-url=<non-loopback>`
//                                     → exit 1; stderr names the
//                                       loopback violation (I-10).
//                                       Docker shim is NEVER
//                                       invoked: ValidateLoopback
//                                       rejects the host before
//                                       any network call.
//
//   * `hub runtime status --health-url=http://127.0.0.1:<port>/status`
//                                     → exit 0; the JSON payload
//                                       contains a populated
//                                       http_health block with the
//                                       loopback URL and the
//                                       server's HTTP status code.
//
//   * `hub runtime ps`                → exit 0; the JSON payload
//                                       surfaces the parsed service
//                                       list (sorted, no http_health
//                                       key).
//
//   * `hub runtime logs`             → exit 0; the docker shim is
//                                       invoked with
//                                         compose -p <project>
//                                                -f <yaml>
//                                                logs --no-color
//                                       and the JSON payload reports
//                                       `command=logs`.
//
//   * bearer hygiene on the status path → process-level
//                                       HUB_BEARER_TOKEN does NOT
//                                       reach the docker shim AND
//                                       does NOT appear on hub's
//                                       own stdout / stderr.
//
//   * no live Docker dependency      → every test passes when the
//                                       host has NO docker on PATH.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildRuntimeHubBinary,
  freshRuntimeHome,
  installFakeDocker,
  runRuntimeHub,
  type FakeDockerRig,
} from './_runtime-harness';
import type { FreshRepoLayout } from './_runtime-harness';
import { assertNoVolumeFlag, findComposeCall } from './_runtime-helpers';

// ---------------------------------------------------------------------------
// Bearer-shape predicates — mirrors internal/output/output.go.
// ---------------------------------------------------------------------------

const BEARER_PREFIXED_OPAQUE = /bearer\s+[A-Za-z0-9._~+/=-]{20,}/i;
const HUB_BEARER_ENV_ASSIGNMENT = /\bHUB_BEARER_TOKEN\b\s*=\s*[^\s,'"]+/i;
const JWT_TRIPLE_SEGMENT = /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/;
const OPAQUE_BEARER = 'abcdefghijklmnopqrstuvwxyz123456';

// ---------------------------------------------------------------------------
// Test helpers (mirroring up-down.test.ts so the file is auditable
// in isolation — pulling helpers into a sibling module would obscure
// which contract each file locks).
// ---------------------------------------------------------------------------

interface StatusRig {
  fakeDocker: FakeDockerRig;
  fresh: FreshRepoLayout;
  cleanup: () => void;
}

function setupStatusRig(label: string): StatusRig {
  const fresh = freshRuntimeHome(label);
  const fakeDocker = installFakeDocker();
  // Surface a precise error if the Go build fails. The harness
  // amortises the build across the suite; the first test pays for
  // the full compile, and a compile error must NOT look like a
  // runtime regression.
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

/**
 * Defence-in-depth on top of findComposeCall: assert there is NO
 * -v / --volumes in the recorded argv. The Service layer enforces
 * this by construction; the test makes sure a refactor that
 * changes the default does not silently regress the audit
 * surface. The shared helper in _runtime-helpers.ts is the
 * chokepoint for this invariant — every hub-runtime test calls it
 * so a regression trips the gate before any volumes can be
 * removed from a real Compose stack.
 */

/**
 * Start a tiny loopback HTTP server that always returns 200 with a
 * known JSON body. Returns the absolute URL plus the server
 * handle so the test can shut it down deterministically in afterEach.
 *
 * Bind address is 127.0.0.1 — explicitly NOT 0.0.0.0 — so this
 * test is hermetic AND satisfies I-10 (loopback-first publication).
 */
function startLoopbackHealthServer(body: string): { url: string; server: Server; close: () => void } {
  let capturedURL = '';
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(body);
  });
  server.listen(0, '127.0.0.1', () => {
    const addr = server.address() as AddressInfo;
    capturedURL = `http://127.0.0.1:${addr.port}/status`;
  });
  return {
    get url() {
      // Lazy read; the server's address is populated asynchronously
      // after listen() returns. Poll briefly until the binding is
      // wired so the test sees a real URL the moment the binary
      // shells out to probe it.
      if (!capturedURL) {
        // Best-effort wait — the synchronous `server.listen` callback
        // is queued before our polling starts; a tiny sleep is
        // sufficient and hermetic.
        const start = Date.now();
        while (!capturedURL && Date.now() - start < 1000) {
          // Busy-wait up to 1s for the listen callback to set
          // capturedURL. Node's event loop pumps the callback
          // synchronously inside listen(...) on macOS for socket
          // binding, so the loop exits within microseconds.
        }
      }
      return capturedURL;
    },
    server,
    close: () => {
      try {
        server.close();
      } catch { /* ignore */ }
    },
  };
}

// ---------------------------------------------------------------------------
// status (human + JSON)
// ---------------------------------------------------------------------------

describe('hub runtime status — fake compose ps argv contract', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) {
      const fn = cleanups.pop();
      try { fn?.(); } catch { /* best-effort */ }
    }
  });

  it('status_exits_zero_and_prints_human_contract_keys', async () => {
    const rig = setupStatusRig('status-human');
    cleanups.push(rig.cleanup);
    const res = await runRuntimeHub(
      ['runtime', 'status'],
      {
        envOverride: {
          HUB_HOME: rig.fresh.home,
          HUB_OPENAPI: rig.fresh.openapi,
        },
        fakeDocker: rig.fakeDocker,
      },
    );
    expect(res.status).toBe(0);
    // Locked human form keys (see cmd_runtime.go's emitRuntime).
    expect(res.stdout).toMatch(/^command=status$/m);
    // T2 polish: HUB_RUNTIME now points at the compose-file
    // path, so the project name must NOT be the literal
    // "hub-runtime" — the harness sets HUB_RUNTIME=<yaml>, which
    // Detect classifies as a compose-file override and falls back
    // to hub-<pid>-<epoch>.
    expect(res.stdout).toMatch(/^project=hub-\d+-\d+$/m);
    expect(res.stdout).toMatch(/^engine=docker-compose$/m);
    expect(res.stdout).toMatch(/^compose_file=/m);
    expect(res.stdout).toMatch(/\/observability\/compose\.yaml$/m);
    expect(res.stderr).toBe('');
  }, 60_000);

  it('status_invokes_compose_ps_format_json_all', async () => {
    const rig = setupStatusRig('status-argv');
    cleanups.push(rig.cleanup);
    const res = await runRuntimeHub(
      ['runtime', 'status'],
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
    // Expected shape (compose.Service.Status):
    //   compose -p <project> -f <yaml> ps --format json --all
    expect(argv[0]).toBe('compose');
    expect(argv[1]).toBe('-p');
    expect(argv[2]).toMatch(/^hub-\d+-\d+$/);
    expect(argv[3]).toBe('-f');
    expect(argv[4]).toMatch(/\/observability\/compose\.yaml$/);
    expect(argv[5]).toBe('ps');
    expect(argv).toContain('--format');
    expect(argv).toContain('json');
    expect(argv).toContain('--all');
    // status must never carry -v / --volumes.
    assertNoVolumeFlag(argv);
    // And status must NOT issue an `up` call — that is the up
    // subcommand's surface; emitting it from status is a regression.
    const up = findComposeCall(calls, 'up');
    expect(up).toBeUndefined();
  }, 60_000);

  it('status_json_payload_contains_locked_top_level_keys', async () => {
    const rig = setupStatusRig('status-json-shape');
    cleanups.push(rig.cleanup);
    const res = await runRuntimeHub(
      ['runtime', 'status', '--json'],
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
    expect(parsed.command).toBe('status');
    expect(parsed.engine).toBe('docker-compose');
    expect(typeof parsed.project).toBe('string');
    expect(parsed.project).toMatch(/^hub-\d+-\d+$/);
    expect(typeof parsed.compose_file).toBe('string');
    expect(parsed.compose_file).toMatch(/\/observability\/compose\.yaml$/);
    expect(Array.isArray(parsed.healthy)).toBe(true);
    expect(Array.isArray(parsed.services)).toBe(true);
    expect(typeof parsed.started_at).toBe('string');
    expect(typeof parsed.finished_at).toBe('string');
    expect(typeof parsed.timeout).toBe('string');
    // status must NOT have volumes_removed; that key is reserved
    // for the down surface. Same lock as up.
    expect('volumes_removed' in parsed).toBe(false);
    // When --health-url is NOT set, http_health is omitted
    // (`omitempty`). A regression that always populates it is a
    // contract-visible change.
    expect(parsed.http_health).toBeUndefined();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// status parses the canonical compose ps JSON envelope
// ---------------------------------------------------------------------------

describe('hub runtime status — parses canned ps --format json --all', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) {
      const fn = cleanups.pop();
      try { fn?.(); } catch { /* best-effort */ }
    }
  });

  it('status_parses_ps_all_json_array_envelope_into_sorted_services', async () => {
    // Compose's `ps --format json --all` emits a JSON array. The
    // fake shim is fed a deliberate array with one unhealthy
    // service and one healthy service, in REVERSE alphabetic order;
    // the parser must sort by Name so the same data on the same host
    // produces byte-identical output.
    const rig = setupStatusRig('status-parse');
    cleanups.push(rig.cleanup);
    const psAllPath = rig.fakeDocker.writePsAllJson(
      JSON.stringify([
        { Name: 'zeta', State: 'running', Health: 'healthy', Image: 'hub/rest:0.1.0', Ports: '127.0.0.1:39421->39421/tcp' },
        { Name: 'alpha', State: 'exited', Health: '', Image: 'hub/mcp:0.1.0', Ports: '' },
      ]),
    );
    const res = await runRuntimeHub(
      ['runtime', 'status', '--json'],
      {
        envOverride: {
          HUB_HOME: rig.fresh.home,
          HUB_OPENAPI: rig.fresh.openapi,
        },
        fakeDocker: rig.fakeDocker,
        fakeDockerPsAllJson: psAllPath,
      },
    );
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout.trim()) as Record<string, unknown>;
    expect(parsed.command).toBe('status');
    const services = parsed.services as Array<Record<string, unknown>>;
    expect(Array.isArray(services)).toBe(true);
    expect(services.length).toBe(2);
    // Sorted by Name (alpha < zeta) — determinism check.
    expect(services[0].name).toBe('alpha');
    expect(services[0].state).toBe('exited');
    expect(services[0].health).toBe('');
    expect(services[1].name).toBe('zeta');
    expect(services[1].state).toBe('running');
    expect(services[1].health).toBe('healthy');
    // `healthy` lists only services reporting Health == "healthy".
    const healthy = parsed.healthy as string[];
    expect(healthy).toEqual(['zeta']);
  }, 60_000);

  it('status_parses_legacy_services_envelope_shape', async () => {
    // Older Compose versions emit `{"services": […]}` instead of a
    // bare top-level array. The Compose package accepts BOTH
    // (see parsePsJSON); we pin that behaviour here so a future
    // refactor that drops the envelope branch is impossible.
    const rig = setupStatusRig('status-legacy-env');
    cleanups.push(rig.cleanup);
    const psAllPath = rig.fakeDocker.writePsAllJson(
      JSON.stringify({
        services: [
          { Name: 'beta', State: 'running', Health: 'healthy', Image: 'hub/rest:0.1.0' },
        ],
      }),
    );
    const res = await runRuntimeHub(
      ['runtime', 'status', '--json'],
      {
        envOverride: {
          HUB_HOME: rig.fresh.home,
          HUB_OPENAPI: rig.fresh.openapi,
        },
        fakeDocker: rig.fakeDocker,
        fakeDockerPsAllJson: psAllPath,
      },
    );
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout.trim()) as Record<string, unknown>;
    const services = parsed.services as Array<Record<string, unknown>>;
    expect(services.length).toBe(1);
    expect(services[0].name).toBe('beta');
    expect(services[0].health).toBe('healthy');
  }, 60_000);
});

// ---------------------------------------------------------------------------
// status --health-url: loopback-first (I-10)
// ---------------------------------------------------------------------------

describe('hub runtime status --health-url — loopback-first contract (I-10)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) {
      const fn = cleanups.pop();
      try { fn?.(); } catch { /* best-effort */ }
    }
  });

  it('status_with_non_loopback_health_url_exits_one_and_skips_probe', async () => {
    // The handler routes --health-url through ValidateLoopback
    // BEFORE any network call. A non-loopback host (e.g. a public
    // IP) is rejected with a precise diagnostic; the docker shim is
    // still invoked (the `ps` pre-poll is unconditional), but the
    // HTTP probe is short-circuited and an error is rendered.
    const rig = setupStatusRig('health-nonloop');
    cleanups.push(rig.cleanup);
    const res = await runRuntimeHub(
      ['runtime', 'status', '--health-url=http://example.com/api/v1/status'],
      {
        envOverride: {
          HUB_HOME: rig.fresh.home,
          HUB_OPENAPI: rig.fresh.openapi,
        },
        fakeDocker: rig.fakeDocker,
      },
    );
    expect(res.status).toBe(1);
    // stderr names the violation.
    expect(res.stderr).toMatch(/loopback/i);
    // Belt-and-braces: hub's own stdout must NOT contain the
    // non-loopback host. A regression that leaks the rejected host
    // via http_health is impossible.
    expect(res.stdout).not.toMatch(/example\.com/);
  }, 60_000);

  it('status_with_loopback_health_url_populates_http_health_in_json', async () => {
    // Bind a real HTTP server on 127.0.0.1, point --health-url at
    // it, and assert the JSON payload carries the captured
    // http_health block with HTTPStatus=200. The server body is a
    // tiny JSON literal so the test is hermetic.
    const rig = setupStatusRig('health-loopback');
    cleanups.push(rig.cleanup);
    const srv = startLoopbackHealthServer('{"status":"up"}');
    cleanups.push(srv.close);
    // Wait for the loopback server to publish its bound port
    // before we hand the URL to the subprocess. The harness
    // polls `srv.url`, but we pin an explicit wait so a slow
    // CI worker does not race the listen() callback.
    const url = await new Promise<string>((resolveUR) => {
      const start = Date.now();
      const tick = () => {
        if (srv.url) resolveUR(srv.url);
        else if (Date.now() - start > 5000) resolveUR('');
        else setTimeout(tick, 5);
      };
      tick();
    });
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/status$/);
    const res = await runRuntimeHub(
      ['runtime', 'status', '--health-url=' + url, '--json'],
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
    const hh = parsed.http_health as Record<string, unknown> | undefined;
    expect(hh).toBeDefined();
    expect(hh!.url).toBe(url);
    expect(hh!.http_status).toBe(200);
    expect(typeof hh!.body).toBe('string');
    expect(hh!.body).toContain('"status":"up"');
    // The fallback contract is "fail-closed": the `error` field is
    // only populated on a failed probe; a 200 response must NOT
    // populate it.
    expect(hh!.error ?? '').toBe('');
  }, 60_000);
});

// ---------------------------------------------------------------------------
// ps — read-only service projection
// ---------------------------------------------------------------------------

describe('hub runtime ps — read-only service projection', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) {
      const fn = cleanups.pop();
      try { fn?.(); } catch { /* best-effort */ }
    }
  });

  it('ps_emits_human_contract_keys_and_invokes_compose_ps_format_json', async () => {
    const rig = setupStatusRig('ps-human');
    cleanups.push(rig.cleanup);
    const res = await runRuntimeHub(
      ['runtime', 'ps'],
      {
        envOverride: {
          HUB_HOME: rig.fresh.home,
          HUB_OPENAPI: rig.fresh.openapi,
        },
        fakeDocker: rig.fakeDocker,
      },
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/^command=ps$/m);
    expect(res.stdout).toMatch(/^project=hub-\d+-\d+$/m);
    expect(res.stdout).toMatch(/^compose_file=/m);
    const calls = res.fakeDockerCalls ?? [];
    const ps = findComposeCall(calls, 'ps');
    expect(ps).toBeTruthy();
    // ps (vs status) does NOT carry --all — the Service.Ps Args
    // list ends at `--format json`. Pin the absence of `--all` so
    // a future refactor that copies Status's argv into Ps is
    // caught here.
    expect(ps!.argv).not.toContain('--all');
    assertNoVolumeFlag(ps!.argv);
  }, 60_000);

  it('ps_json_payload_lists_services_without_http_health', async () => {
    const rig = setupStatusRig('ps-json');
    cleanups.push(rig.cleanup);
    const psPath = rig.fakeDocker.writePsJson(
      JSON.stringify([
        { Name: 'mcp', State: 'running', Health: 'healthy', Image: 'hub/mcp:0.1.0' },
      ]),
    );
    const res = await runRuntimeHub(
      ['runtime', 'ps', '--json'],
      {
        envOverride: {
          HUB_HOME: rig.fresh.home,
          HUB_OPENAPI: rig.fresh.openapi,
        },
        fakeDocker: rig.fakeDocker,
        fakeDockerPsJson: psPath,
      },
    );
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout.trim()) as Record<string, unknown>;
    expect(parsed.command).toBe('ps');
    const services = parsed.services as Array<Record<string, unknown>>;
    expect(services.length).toBe(1);
    expect(services[0].name).toBe('mcp');
    expect(services[0].health).toBe('healthy');
    // ps is the read-only projection: it MUST NOT carry an
    // http_health block — the operator calls `status` for that
    // surface.
    expect(parsed.http_health).toBeUndefined();
    expect('volumes_removed' in parsed).toBe(false);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// logs — line-capture contract
// ---------------------------------------------------------------------------

describe('hub runtime logs — fake compose logs contract', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) {
      const fn = cleanups.pop();
      try { fn?.(); } catch { /* best-effort */ }
    }
  });

  it('logs_invokes_compose_with_no_color_and_emits_command_logs', async () => {
    const rig = setupStatusRig('logs-argv');
    cleanups.push(rig.cleanup);
    const res = await runRuntimeHub(
      ['runtime', 'logs'],
      {
        envOverride: {
          HUB_HOME: rig.fresh.home,
          HUB_OPENAPI: rig.fresh.openapi,
        },
        fakeDocker: rig.fakeDocker,
      },
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/^command=logs$/m);
    const calls = res.fakeDockerCalls ?? [];
    const logs = findComposeCall(calls, 'logs');
    expect(logs).toBeTruthy();
    const argv = logs!.argv;
    expect(argv[0]).toBe('compose');
    expect(argv[1]).toBe('-p');
    expect(argv[3]).toBe('-f');
    expect(argv[5]).toBe('logs');
    expect(argv).toContain('--no-color');
    assertNoVolumeFlag(argv);
  }, 60_000);

  it('logs_with_tail_forwards_tail_n_to_compose', async () => {
    const rig = setupStatusRig('logs-tail');
    cleanups.push(rig.cleanup);
    const res = await runRuntimeHub(
      ['runtime', 'logs', '--tail', '50'],
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
    const logs = findComposeCall(calls, 'logs');
    expect(logs).toBeTruthy();
    // The Service forwards `--tail <n>` as a pair. Index-of-pair
    // assertion keeps the test robust against future flag
    // re-orderings.
    const argv = logs!.argv;
    const tailIdx = argv.indexOf('--tail');
    expect(tailIdx).toBeGreaterThanOrEqual(0);
    expect(argv[tailIdx + 1]).toBe('50');
  }, 60_000);

  it('logs_with_unsafe_service_name_exits_one_and_skips_docker', async () => {
    // The Service layer validates --service against a strict
    // charset (Compose's documented service alphabet). Anything
    // outside the alphabet is rejected with a precise diagnostic
    // and the docker shim is NEVER invoked.
    const rig = setupStatusRig('logs-unsafe');
    cleanups.push(rig.cleanup);
    const res = await runRuntimeHub(
      ['runtime', 'logs', '--service', 'drop;table'],
      {
        envOverride: {
          HUB_HOME: rig.fresh.home,
          HUB_OPENAPI: rig.fresh.openapi,
        },
        fakeDocker: rig.fakeDocker,
      },
    );
    expect(res.status).toBe(1);
    const calls = res.fakeDockerCalls ?? [];
    const logs = findComposeCall(calls, 'logs');
    expect(logs).toBeUndefined();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Bearer hygiene on the status / ps / logs path
// ---------------------------------------------------------------------------

describe('hub runtime — bearer-shaped env is sanitized across status / ps / logs', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) {
      const fn = cleanups.pop();
      try { fn?.(); } catch { /* best-effort */ }
    }
  });

  for (const sub of ['status', 'ps', 'logs'] as const) {
    const label = `bearer-${sub}`;
    it(`${sub}_process_level_bearer_does_not_reach_docker_subprocess`, async () => {
      // I-07 invariant: a process-level HUB_BEARER_TOKEN is set
      // BEFORE hub starts; the Service's sanitizeEnv strips it
      // before the docker subprocess env is built. Every recorded
      // invocation MUST see HUB_BEARER_TOKEN=''. (The harness
      // also strips HUB_BEARER_TOKEN* keys from the parent env
      // — we deliberately re-introduce it here to prove the
      // binary also strips.)
      const rig = setupStatusRig(label);
      cleanups.push(rig.cleanup);
      const res = await runRuntimeHub(
        ['runtime', sub],
        {
          envOverride: {
            HUB_HOME: rig.fresh.home,
            HUB_OPENAPI: rig.fresh.openapi,
            HUB_BEARER_TOKEN: OPAQUE_BEARER,
          },
          fakeDocker: rig.fakeDocker,
        },
      );
      expect(res.status).toBe(0);
      const calls = res.fakeDockerCalls ?? [];
      expect(calls.length).toBeGreaterThan(0);
      for (const c of calls) {
        const b = (c as { env_bearers?: Record<string, string> }).env_bearers ?? {};
        expect(b.HUB_BEARER_TOKEN ?? '').toBe('');
        expect(b.HUB_BEARER_TOKEN_FILE ?? '').toBe('');
        expect(b.HUB_BEARER_TOKEN_SOURCE ?? '').toBe('');
        expect(b.AGENT_MEMORY_BEARER_TOKEN ?? '').toBe('');
      }
      // Belt-and-braces: the redaction path means hub's own
      // stdout / stderr MUST NOT contain the opaque literal.
      expect(res.stdout).not.toContain(OPAQUE_BEARER);
      expect(res.stderr).not.toContain(OPAQUE_BEARER);
      // And the regex sweep matches the redaction contract.
      expect(res.stdout).not.toMatch(BEARER_PREFIXED_OPAQUE);
      expect(res.stdout).not.toMatch(HUB_BEARER_ENV_ASSIGNMENT);
      expect(res.stdout).not.toMatch(JWT_TRIPLE_SEGMENT);
    }, 60_000);
  }
});
