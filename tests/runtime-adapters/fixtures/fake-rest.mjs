#!/usr/bin/env node
// tests/runtime-adapters/fixtures/fake-rest.mjs
//
// A no-op HTTP fixture the FASE 4 tests can spawn to validate
// `--rest-url` plumbing without depending on the real REST server.
// Replies 200 OK with a fixed JSON body on every path.

import { createServer } from 'node:http';

const port = Number(process.env.FAKE_REST_PORT ?? 0);
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    ok: true,
    method: req.method,
    url: req.url,
    name: 'agent-memory-fake-rest',
  }));
});
server.listen(port, () => {
  const address = server.address();
  const resolvedPort = typeof address === 'object' && address ? address.port : port;
  // The first line on stdout is consumed by the parent driver as
  // the URL; the rest is diagnostic noise that the parent ignores.
  process.stdout.write(`http://127.0.0.1:${resolvedPort}\n`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
