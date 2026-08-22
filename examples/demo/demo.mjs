// End-to-end demo of the Portable Agent Asset Hub.
//
// Runs entirely locally against a throwaway SQLite database and a
// throwaway Hermes target directory:
//
//   1. create a profile in the hub (governed store, audited transaction);
//   2. start the REST server in loopback local mode;
//   3. preview a Hermes materialization over HTTP;
//   4. show the CAS contract: apply without If-Match is rejected (428);
//   5. apply with If-Match and inspect the files written to the target;
//   6. tamper with the target and show drift detection (412);
//   7. roll back the run and verify the exact prior state is restored;
//   8. print the hub's audit trail counts.
//
// Usage: pnpm install && pnpm build && node examples/demo/demo.mjs

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createActorContext } from '@portable-agent-asset-hub/core';
import { SqliteStore } from '@portable-agent-asset-hub/storage-sqlite';
import { observedManifestDigest } from '@portable-agent-asset-hub/materializers';
import { hermesMaterializerDispatcher } from '@portable-agent-asset-hub/materializers/hermes';
import { listen } from '@portable-agent-asset-hub/rest';

const step = (title) => console.log(`\n=== ${title}`);
const show = (label, value) => console.log(`    ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);

const home = mkdtempSync(join(tmpdir(), 'pah-demo-'));
const target = join(home, 'hermes', 'state');
mkdirSync(target, { recursive: true });

const actor = createActorContext({
  userId: 'usr_demo',
  agentId: 'agt_demo',
  role: 'user',
  capabilities: ['admin.materialize', 'materialization.apply', 'materialization.preview'],
});

const store = new SqliteStore(join(home, 'hub.db'));
let server;
try {
  step('1. Create a profile in the hub (audited transaction)');
  store.transaction(actor, (tx) => {
    tx.profiles.create(
      {
        id: 'prf_demo',
        scope: actor.scope,
        version: 1,
        blocks: [
          { blockId: 'user', ordinal: 1, kind: 'USER', body: 'Demo user: prefers terse answers.' },
          { blockId: 'mem', ordinal: 2, kind: 'MEMORY', body: 'Demo memory: the hub is the canonical source.' },
        ],
      },
      { reason: 'demo-create', requestId: 'req-demo-create' },
    );
  });
  show('profile', 'prf_demo (2 blocks, version 1)');

  step('2. Start the REST server (loopback local mode)');
  server = await listen({
    hub: {
      doctor: () => ({ ok: true }),
      dispatch: hermesMaterializerDispatcher({ store, actor, targetRoot: target, lockDir: target }),
    },
    localMode: true,
    localActor: actor,
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${base}/api/v1/health`)).json();
  show('GET /api/v1/health', health);

  step('3. Preview the materialization over HTTP');
  const previewRes = await fetch(`${base}/api/v1/materializations/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ harness: 'hermes', profileId: 'prf_demo', snapshotId: 'snap_demo' }),
  });
  const preview = await previewRes.json();
  show('status', previewRes.status);
  for (const file of preview.plan.files) show('planned file', `${file.relativePath} (${file.sha256.slice(0, 12)}…)`);

  step('4. CAS contract: apply without If-Match is rejected');
  const noCas = await fetch(`${base}/api/v1/materializations/apply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ harness: 'hermes', profileId: 'prf_demo', snapshotId: 'snap_demo' }),
  });
  show('status', `${noCas.status} (${(await noCas.json()).error.code})`);

  step('5. Apply with If-Match');
  const applyRes = await fetch(`${base}/api/v1/materializations/apply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'if-match': `"${preview.observedDigest}"` },
    body: JSON.stringify({ harness: 'hermes', profileId: 'prf_demo', snapshotId: 'snap_demo' }),
  });
  const applied = await applyRes.json();
  show('status', applyRes.status);
  show('runId', applied.runId);
  const memoryPath = join(target, 'MEMORY.md');
  const originalBytes = readFileSync(memoryPath, 'utf8');
  show('MEMORY.md on disk', originalBytes.split('\n')[0]);

  step('6. Tamper with the target: drift is detected (412)');
  writeFileSync(memoryPath, 'tampered by demo');
  const drifted = observedManifestDigest(target);
  const driftRes = await fetch(`${base}/api/v1/materializations/apply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'if-match': `"${preview.observedDigest}"` },
    body: JSON.stringify({ harness: 'hermes', profileId: 'prf_demo', snapshotId: 'snap_demo', observedDigest: drifted }),
  });
  show('status', `${driftRes.status} (${(await driftRes.json()).error.code})`);

  step('7. Roll back the run: prior bytes are restored');
  const rollbackRes = await fetch(`${base}/api/v1/materializations/${applied.runId}/rollback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'if-match': `"${drifted}"` },
    body: JSON.stringify({ runId: applied.runId, reason: 'demo-rollback' }),
  });
  show('status', rollbackRes.status);
  show('MEMORY.md after rollback', existsSync(memoryPath) ? readFileSync(memoryPath, 'utf8').split('\n')[0] : '(removed — target restored to pre-apply state)');

  step('8. Audit trail');
  show('counts', store.diagnostics().counts);
  console.log('\nDone: preview → 428 without CAS → apply → 412 on drift → rollback, all audited.\n');
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  store.close();
  rmSync(home, { recursive: true, force: true });
}
