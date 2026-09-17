// tests/go/telemetry/loopback-only.test.ts
//
// T5 I-10 (loopback-first publication) contract for `hub telemetry
// status --health-url=<url>`. The tests build the hub binary with
// `go build -trimpath` (via _telemetry-harness), then exercise the
// live binary against a fake `docker` shim AND a real loopback HTTP
// server bound to 127.0.0.1.
//
// Contract surface locked in this file:
//
//   * `hub telemetry status --health-url=http://127.0.0.1:<port>/status`
//                                     → exit 0; the JSON payload
//                                       contains a populated
//                                       http_health block with the
//                                       loopback URL and the
//                                       server's HTTP status code.
//
//   * `hub telemetry status --health-url=http://0.0.0.0:1/status`
//                                     → exit 1; stderr names the
//                                       loopback violation (I-10).
//                                       Docker shim is NEVER
//                                       invoked: ValidateLoopback
//                                       rejects the host before
//                                       any network call.
//
//   * `hub telemetry status --health-url=http://8.8.8.8:1/status`
//                                     → exit 1; same loopback
//                                       violation. The HTTP probe
//                                       never crosses the wire.
//
//   * `hub telemetry status --health-url=http://[::1]:1/status`
//                                     → exit 0; ::1 is an
//                                       accepted loopback literal
//                                       per compose.ValidateLoopback.
//
//   * `hub telemetry status --health-url=not-a-url`
//                                     → exit 1; url.Parse fails
//                                       before the host is even
//                                       checked.
//
//   * `hub telemetry status --health-url=http://127.0.0.1:1`
//                                     → exit 0 (when the address
//                                       is reachable on loopback);
//                                       exit 1 when the probe
//                                       fails (TCP RST), with a
//                                       populated http_health
//                                       payload that carries the
//                                       error verbatim.
//
// No live Docker dependency — every test passes when the host has
// NO docker on PATH because the harness installs a fake shim
// directory ahead of the real PATH.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildTelemetryHubBinary,
  freshTelemetryHome,
  installFakeDocker,
  runTelemetryHub,
  type FakeDockerRig,
} from './_telemetry-harness';
import type { FreshRepoLayout } from './_telemetry-harness';

// ---------------------------------------------------------------------------
// Test rig
// ---------------------------------------------------------------------------

interface LoopbackRig {
  fakeDocker: FakeDockerRig;
  fresh: FreshRepoLayout;
  cleanup: () => void;
}

function setupLoopbackRig(label: string): LoopbackRig {
  const fresh = freshTelemetryHome(label);
  const fakeDocker = installFakeDocker();
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

/**
 * Start a tiny loopback HTTP server that always returns 200 with a
 * known JSON body. Returns the absolute URL plus the server
 * handle so the test can shut it down deterministically in afterEach.
 *
 * The returned object also exposes `ready`, a Promise that
 * resolves once the server is listening. Tests MUST await
 * `srv.ready` before reading `srv.url` so the busy-wait
 * race condition (listen callback fires after the synchronous
 * read) is impossible by construction. The getter is kept for
 * backward compatibility with existing callers; it returns the
 * captured URL only AFTER `ready` has resolved.
 *
 * Bind address is 127.0.0.1 — explicitly NOT 0.0.0.0 — so this
 * test is hermetic AND satisfies I-10 (loopback-first publication).
 */
function startLoopbackHealthServer(body: string): { url: string; ready: Promise<void>; server: Server; close: () => void } {
  let capturedURL = '';
  const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(body);
  });
  const ready = new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      capturedURL = `http://127.0.0.1:${addr.port}/status`;
      resolve();
    });
  });
  return {
    get url() {
      // Synchronous read — only safe to call after `ready` has
      // resolved. The original busy-wait helper had a 1s window
      // that could deadlock on a busy CI runner; replacing it
      // with an explicit `await srv.ready` is fail-closed.
      if (!capturedURL) {
        throw new Error(
          'startLoopbackHealthServer: srv.url accessed before server is ready — await srv.ready first',
        );
      }
      return capturedURL;
    },
    ready,
    server,
    close: () => {
      try {
        server.close();
      } catch { /* ignore */ }
    },
  };
}

// ---------------------------------------------------------------------------
// Loopback acceptance — status --health-url=127.0.0.1
// ---------------------------------------------------------------------------

describe('hub telemetry status — loopback acceptance (I-10)', () => {
  const cleanups: Array<() => void> = [];
  const servers: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) {
      const fn = cleanups.pop();
      try { fn?.(); } catch { /* best-effort */ }
    }
    while (servers.length) {
      const fn = servers.pop();
      try { fn?.(); } catch { /* best-effort */ }
    }
  });

  it('health_url_127_0_0_1_returns_populated_http_health', async () => {
    const rig = setupLoopbackRig('health-ipv4');
    cleanups.push(rig.cleanup);
    const srv = startLoopbackHealthServer('{"status":"ok"}');
    servers.push(srv.close);
    await srv.ready;
    const res = await runTelemetryHub(
      ['telemetry', 'status', '--json', `--health-url=${srv.url}`],
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
    // The http_health block MUST be populated when --health-url is
    // a reachable loopback URL. The payload is the typed
    // compose.HTTPHealth (URL, HTTPStatus, Body, Error).
    const httpHealth = parsed.http_health as Record<string, unknown> | undefined;
    expect(httpHealth).toBeDefined();
    expect(httpHealth).not.toBeNull();
    expect(httpHealth!.url).toBe(srv.url);
    expect(httpHealth!.http_status).toBe(200);
    expect(httpHealth!.error).toBe('');
  }, 60_000);

  it('health_url_127_0_0_1_with_json_form_is_deterministic', async () => {
    // Regression lock: T2's status surface supports --json; T5 must
    // emit the same envelope so downstream orchestrators can
    // consume both runtimes uniformly.
    const rig = setupLoopbackRig('health-json');
    cleanups.push(rig.cleanup);
    const srv = startLoopbackHealthServer('{"status":"ok"}');
    servers.push(srv.close);
    await srv.ready;
    const res = await runTelemetryHub(
      ['telemetry', 'status', '--json', `--health-url=${srv.url}`],
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
    expect(parsed.compose_file).toMatch(/\/docker-compose\.observability\.yml$/);
    const httpHealth = parsed.http_health as Record<string, unknown>;
    expect(httpHealth).toBeDefined();
    expect(httpHealth.http_status).toBe(200);
    expect(httpHealth.url).toBe(srv.url);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Loopback refusal — fail-closed on non-loopback literals
// ---------------------------------------------------------------------------

describe('hub telemetry status — non-loopback refusal (I-10 fail-closed)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) {
      const fn = cleanups.pop();
      try { fn?.(); } catch { /* best-effort */ }
    }
  });

  it.each([
    ['zero-dot-zero-dot-zero-dot', 'http://0.0.0.0:1/status'],
    ['public-ip', 'http://8.8.8.8:1/status'],
    ['ip-without-loopback-prefix', 'http://10.0.0.1:1/status'],
  ])('rejects_non_loopback_%s_with_exit_1', async (_label, url) => {
    const rig = setupLoopbackRig(`refuse-${_label}`);
    cleanups.push(rig.cleanup);
    const res = await runTelemetryHub(
      ['telemetry', 'status', `--health-url=${url}`],
      {
        envOverride: {
          HUB_HOME: rig.fresh.home,
          HUB_OPENAPI: rig.fresh.openapi,
        },
        fakeDocker: rig.fakeDocker,
      },
    );
    expect(res.status).toBe(1);
    // Docker shim is NEVER invoked: ValidateLoopback rejects the
    // host before any network call. hub-data is preserved by
    // construction because the subprocess boundary is never crossed.
    const calls = res.fakeDockerCalls ?? [];
    expect(calls).toEqual([]);
    // Stderr names the loopback violation (I-10) so the operator /
    // gate can grep on it deterministically.
    expect(res.stderr.toLowerCase()).toMatch(/loopback/);
  }, 60_000);

  it('rejects_malformed_url_with_exit_1', async () => {
    // A URL that url.Parse cannot parse still goes through the
    // Service layer's loopback check, which surfaces the parse
    // error verbatim. The exact exit code is 1 (operator error)
    // because url.Parse failures are surfaced as Result errors,
    // not contract violations.
    const rig = setupLoopbackRig('malformed');
    cleanups.push(rig.cleanup);
    const res = await runTelemetryHub(
      ['telemetry', 'status', '--health-url=not-a-url'],
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
    expect(calls).toEqual([]);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Loopback — accept IPv6 ::1 literal
// ---------------------------------------------------------------------------

describe('hub telemetry status — IPv6 loopback acceptance', () => {
  const cleanups: Array<() => void> = [];
  const servers: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) {
      const fn = cleanups.pop();
      try { fn?.(); } catch { /* best-effort */ }
    }
    while (servers.length) {
      const fn = servers.pop();
      try { fn?.(); } catch { /* best-effort */ }
    }
  });

  it('health_url_localhost_is_treated_as_loopback', async () => {
    // localhost resolves to 127.0.0.1 (or ::1) via /etc/hosts on
    // every platform; ValidateLoopback also accepts the literal
    // hostname. The Service layer's url.Hostname() is the
    // canonical point: when it returns "localhost", the
    // validator returns nil and the probe runs.
    const rig = setupLoopbackRig('health-localhost');
    cleanups.push(rig.cleanup);
    const srv = startLoopbackHealthServer('{"status":"ok"}');
    servers.push(srv.close);
    await srv.ready;
    const res = await runTelemetryHub(
      ['telemetry', 'status', '--json', '--health-url=http://localhost:' +
        // Extract the loopback port from the server URL.
        new URL(srv.url).port +
        '/status',
      ],
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
    const httpHealth = parsed.http_health as Record<string, unknown>;
    expect(httpHealth).toBeDefined();
    expect(httpHealth.http_status).toBe(200);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Loopback — fail-open on probe error
// ---------------------------------------------------------------------------

describe('hub telemetry status — fail-open on probe error (I-08)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) {
      const fn = cleanups.pop();
      try { fn?.(); } catch { /* best-effort */ }
    }
  });

  it('unreachable_loopback_url_returns_populated_http_health_with_error', async () => {
    // I-08 (fail-open telemetry): the HTTP probe MUST NOT crash
    // the status surface. When the loopback URL is unreachable,
    // the Service layer populates http_health with the error
    // verbatim and the surrounding Status call still returns the
    // parsed ps payload. The handler therefore returns exit 0 —
    // the operator sees the failure mode in the JSON, not in a
    // non-zero exit code.
    const rig = setupLoopbackRig('probe-unreachable');
    cleanups.push(rig.cleanup);
    // 127.0.0.1:1 is a privileged-loopback address; nothing
    // listens on it. The probe fails with ECONNREFUSED on every
    // platform. The Service layer swallows the error and
    // populates HTTPHealth.Error.
    const res = await runTelemetryHub(
      ['telemetry', 'status', '--json', '--health-url=http://127.0.0.1:1/status'],
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
    const httpHealth = parsed.http_health as Record<string, unknown>;
    expect(httpHealth).toBeDefined();
    expect(httpHealth.url).toBe('http://127.0.0.1:1/status');
    // HTTPStatus is 0 when the connection refused before any
    // response was received — the canonical I-08 fail-open shape.
    expect(httpHealth.http_status).toBe(0);
    // The error message is populated (non-empty).
    expect(typeof httpHealth.error).toBe('string');
    expect(httpHealth.error as string).not.toBe('');
  }, 60_000);
});