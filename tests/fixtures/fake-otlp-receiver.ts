// tests/fixtures/fake-otlp-receiver.ts
//
// Lightweight OTLP/HTTP receiver for tests. It binds to a loopback port,
// accepts POST /v1/traces and POST /v1/metrics, captures the JSON-encoded
// payload (or Protobuf-as-bytes), and exposes the captured records to the
// caller via `received()`.
//
// The receiver is intentionally minimal: no authentication, no persistence,
// no validation beyond JSON parsing. It exists to prove that the live
// telemetry kernel pushes what the plan promises — service resource,
// span correlation, allowlisted attributes — without inventing mock
// behaviour in the test.
//
// Usage:
//   const recv = await startFakeOtlpReceiver();
//   ...run the smoke against recv.endpoint...
//   const traces = recv.received('traces');
//   await recv.close();

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createConnection } from 'node:net';
import type { AddressInfo } from 'node:net';

type Recorded = {
  kind: 'traces' | 'metrics';
  contentType: string;
  body: Buffer;
  receivedAt: number;
};

export type FakeOtlpReceiver = {
  endpoint: string;
  baseUrl: string;
  received(kind: 'traces' | 'metrics'): Recorded[];
  close(): Promise<void>;
};

export async function startFakeOtlpReceiver(): Promise<FakeOtlpReceiver> {
  const captured: Recorded[] = [];
  let serverRef: Server | null = null;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.once('end', () => {
      const body = Buffer.concat(chunks);
      const kind: 'traces' | 'metrics' | null = req.url === '/v1/traces'
        ? 'traces'
        : req.url === '/v1/metrics'
          ? 'metrics'
          : null;
      if (kind) {
        captured.push({
          kind,
          contentType: String(req.headers['content-type'] ?? ''),
          body,
          receivedAt: Date.now(),
        });
      }
      // OTLP expects `success` status with empty body — match the real
      // collector's response shape so the test surfaces any deviations.
      res.statusCode = kind ? 200 : 404;
      res.setHeader('content-type', 'application/json');
      res.end('{}');
    });
  });
  serverRef = server;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  const endpoint = `http://127.0.0.1:${address.port}`;
  return {
    endpoint,
    baseUrl: endpoint,
    received(kind: 'traces' | 'metrics'): Recorded[] {
      return captured.filter((entry) => entry.kind === kind);
    },
    async close(): Promise<void> {
      const ref = serverRef;
      serverRef = null;
      if (!ref) return;
      await new Promise<void>((resolveClose) => {
        ref.close(() => resolveClose());
        // Stop accepting new connections immediately so the parent process
        // can shut down without keeping the loopback listener alive.
        ref.closeAllConnections?.();
      });
    },
  };
}

/** Allocate a free loopback TCP port and return it. */
export function allocateFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address() as AddressInfo;
      probe.close(() => resolvePort(address.port));
    });
  });
}

/** Connect to a TCP port; resolves when the connection is established. */
export async function waitForTcp(host: string, port: number, deadlineMs = 10_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (Date.now() - start > deadlineMs) throw new Error(`tcp ${host}:${port} not reachable within ${deadlineMs}ms`);
    try {
      await new Promise<void>((resolveConn, rejectConn) => {
        const socket = createConnection({ host, port }, () => {
          socket.end();
          resolveConn();
        });
        socket.once('error', rejectConn);
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}