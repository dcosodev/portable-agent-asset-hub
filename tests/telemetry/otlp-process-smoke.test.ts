// tests/telemetry/otlp-process-smoke.test.ts
//
// Real OTLP smoke: spawn the compiled launcher with telemetry enabled,
// point its OTLP HTTP exporter at a local fake receiver, drive a few
// requests, then verify the captured payloads contain the expected
// service resource + span attributes. Also exercises the collector-down
// branch: when the receiver closes, the launcher must keep serving
// requests without leaking errors.
//
// The receiver parses JSON only — protobuf payloads are accepted but
// not introspected, because the kernel exporters default to JSON unless
// OTEL_EXPORTER_OTLP_PROTOCOL=grpc/protobuf is set. We keep this test on
// the JSON path to avoid a heavy dependency.

import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeOtlpReceiver, type FakeOtlpReceiver } from '../fixtures/fake-otlp-receiver.js';

interface LauncherChild {
  child: ChildProcess;
  url: string;
  kill(): Promise<void>;
  stderrText(): string;
}

async function startLauncher(env: Record<string, string | undefined>): Promise<LauncherChild> {
  const dbDir = mkdtempSync(join(tmpdir(), 'hub-otlp-'));
  const dbPath = join(dbDir, 'agent-memory.sqlite');
  const port = 39500 + Math.floor(Math.random() * 200);
  const child = spawn(process.execPath, ['packages/rest/bin/agent-memory-rest.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...env,
      AGENT_MEMORY_DB_PATH: dbPath,
      PORT: String(port),
      HOST: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  // The launcher emits `AGENT_MEMORY_READY` on stderr (stdout is reserved
  // for HTTP responses). Capture both pipes so the test still observes the
  // readiness line.
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  child.stdout?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  const ready = await new Promise<string>((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error(`launcher readiness timeout: ${stderr}`)), 12_000);
    let resolved = false;
    const checkBuffer = (text: string): void => {
      if (resolved) return;
      const line = text.split('\n').find((entry) => entry.startsWith('AGENT_MEMORY_READY '));
      if (!line) return;
      resolved = true;
      clearTimeout(timer);
      try {
        const payload = JSON.parse(line.slice('AGENT_MEMORY_READY '.length)) as { url: string };
        resolveReady(payload.url);
      } catch (error) {
        rejectReady(error);
      }
    };
    const onData = (chunk: Buffer): void => {
      stderr += chunk.toString('utf8');
      checkBuffer(stderr);
    };
    child.stderr?.on('data', onData);
    child.stdout?.on('data', onData);
    child.once('error', rejectReady);
  });
  return {
    child,
    url: ready,
    kill: async () => {
      child.kill('SIGTERM');
      await new Promise<void>((resolveExit) => {
        child.once('exit', () => resolveExit());
        setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already exited */ } resolveExit(); }, 3_000);
      });
      rmSync(dbDir, { recursive: true, force: true });
    },
    stderrText: () => stderr,
  };
}

describe('OTLP process smoke', () => {
  let receiver: FakeOtlpReceiver | undefined;
  let launcher: LauncherChild | undefined;

  afterEach(async () => {
    if (launcher) await launcher.kill();
    launcher = undefined;
    if (receiver) await receiver.close();
    receiver = undefined;
  });

  it('emits hub.request spans with bounded attributes to a real OTLP endpoint', async () => {
    receiver = await startFakeOtlpReceiver();
    const startedAt = Date.now();
    launcher = await startLauncher({
      TELEMETRY_LEVEL: 'standard',
      OTEL_EXPORTER_OTLP_ENDPOINT: receiver.endpoint,
      // The kernel minimum is 1000ms — passing that exact value avoids
      // the diagnostic warning while keeping the periodic reader tight
      // enough to flush inside the test window.
      TELEMETRY_EXPORT_INTERVAL_MS: '1000',
    });
    expect(launcher.url).toMatch(/http:\/\/127\.0\.0\.1:\d+/);
    // Issue several requests so the kernel's batch processor has data to
    // export; the launcher stays up long enough for the periodic reader
    // to flush at least once.
    for (let i = 0; i < 6; i += 1) {
      const response = await fetch(`${launcher.url}/api/v1/health`);
      expect(response.status).toBe(200);
    }
    await launcher.kill();
    const traces = receiver.received('traces');
    expect(traces.length).toBeGreaterThan(0);
    expect(traces[0]!.contentType).toMatch(/json/);
    const aggregate = traces.map((entry) => entry.body.toString('utf8')).join('');
    expect(aggregate).toContain('hub.request');
    expect(aggregate).toContain('hub.operation_id');
    expect(aggregate).toContain('http.response.status_code');
    // Canary markers MUST NOT appear in the wire payload.
    expect(aggregate).not.toContain('top-secret-token-12345678');
    expect(Date.now() - startedAt).toBeLessThan(25_000);
    launcher = undefined;
  });

  it('keeps serving requests when the OTLP endpoint is unreachable', async () => {
    receiver = await startFakeOtlpReceiver();
    await receiver.close();
    receiver = undefined;
    launcher = await startLauncher({
      TELEMETRY_LEVEL: 'standard',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1',
      TELEMETRY_EXPORT_INTERVAL_MS: '1000',
    });
    const health = await fetch(`${launcher.url}/api/v1/health`);
    expect(health.status).toBe(200);
    const capabilities = await fetch(`${launcher.url}/api/v1/capabilities`);
    expect(capabilities.status).toBe(200);
    const body = await capabilities.json() as { features?: Record<string, boolean> };
    expect(body.features?.skills).toBe(true);
  });
});