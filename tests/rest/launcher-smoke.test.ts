import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { SqliteStore } from '@portable-agent-asset-hub/storage-sqlite';
import { createActorContext } from '@portable-agent-asset-hub/core';

const repoRoot = resolve(import.meta.dirname, '../..');
const bin = join(repoRoot, 'packages/rest/bin/agent-memory-rest.mjs');
const children: ChildProcess[] = [];
const tempRoots: string[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (!child.killed) child.kill('SIGKILL');
  }
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * Allocate a free loopback TCP port and return it. We bind briefly on
 * port 0 to let the kernel assign an unused port, then release it. The
 * launcher refuses port 0 in its own env-var validation, so the test
 * must hand it a real, free port.
 */
async function allocateFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') {
        probe.close(() => reject(new Error('probe did not return numeric address')));
        return;
      }
      const port = address.port;
      probe.close(() => resolvePort(port));
    });
  });
}

async function waitReady(child: ChildProcess): Promise<{ url: string; dbPath: string; stderr: string }> {
  let stderr = '';
  return new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error(`launcher readiness timeout: ${stderr}`)), 10_000);
    if (!child.stderr) throw new Error('launcher stderr pipe missing');
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      const line = stderr.split('\n').find((entry) => entry.startsWith('AGENT_MEMORY_READY '));
      if (!line) return;
      clearTimeout(timer);
      resolveReady({ ...JSON.parse(line.slice('AGENT_MEMORY_READY '.length)) as { url: string; dbPath: string }, stderr });
    });
    child.once('error', reject);
  });
}

describe('durable REST launcher', () => {
  it('serves graph relations/dependents and mandatory retrieval through the real REST process', async () => {
    const root = mkdtempSync(join(repoRoot, '.tmp-rest-skill-graph-'));
    tempRoots.push(root);
    const dbPath = join(root, 'agent-memory.sqlite');
    const actor = createActorContext({ userId: 'usr_local', agentId: 'agt_local', role: 'admin', capabilities: ['read', 'write.skill', 'admin'] });
    const seed = new SqliteStore(dbPath);
    try {
      seed.transaction(actor, (tx) => tx.skills.writeSkill({ id: 'skl_docker', scope: actor.scope, logicalKey: 'skill:docker', kind: 'skill', name: 'docker-build', summary: 'docker build container', lifecycle: 'active', body: Buffer.from('# docker'), metadata: {}, resources: [] }, { reason: 'seed', requestId: 'req_docker' }));
      seed.transaction(actor, (tx) => tx.skills.writeSkill({ id: 'skl_k8s', scope: actor.scope, logicalKey: 'skill:k8s', kind: 'skill', name: 'kubernetes-deployment', summary: 'deploy api kubernetes helm', lifecycle: 'active', body: Buffer.from('# k8s'), metadata: {}, resources: [], relations: [{ type: 'requires', targetSkillId: 'skl_docker', targetVersion: 1 }] }, { reason: 'seed', requestId: 'req_k8s' }));
    } finally { seed.close(); }
    const child = spawn(process.execPath, [bin], { cwd: repoRoot, env: { ...process.env, AGENT_MEMORY_DB_PATH: dbPath, PORT: String(await allocateFreePort()), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    const ready = await waitReady(child);
    const relations = await fetch(`${ready.url}/api/v1/skills/skl_k8s/relations?version=1`);
    expect(relations.status).toBe(200);
    expect((await relations.json() as { items: Array<{ targetSkillId: string }> }).items[0]?.targetSkillId).toBe('skl_docker');
    const dependents = await fetch(`${ready.url}/api/v1/skills/skl_docker/dependents`);
    expect((await dependents.json() as { items: Array<{ sourceSkillId: string }> }).items[0]?.sourceSkillId).toBe('skl_k8s');
    const graph = await fetch(`${ready.url}/api/v1/skills/resolve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ skill: 'skl_k8s', version: 1 }) });
    expect(graph.status).toBe(200);
    expect((await graph.json() as { resolved: Array<{ skillId: string }> }).resolved.map((node) => node.skillId)).toEqual(['skl_docker']);
    const retrieval = await fetch(`${ready.url}/api/v1/retrieval/resolve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'Despliega esta API en Kubernetes', profile: 'default', limits: { supportingThreshold: 0.3 } }) });
    expect(retrieval.status).toBe(200);
    const decision = await retrieval.json() as { policy: { skillRetrievalRequired: boolean }; skills: Array<{ skillId: string; reason: string }> };
    expect(decision.policy.skillRetrievalRequired).toBe(true);
    expect(decision.skills).toContainEqual(expect.objectContaining({ skillId: 'skl_docker', reason: 'dependency' }));
    const missingCas = await fetch(`${ready.url}/api/v1/skills/skl_k8s/relations`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedVersion: 1, relations: [] }) });
    expect(missingCas.status).toBe(428);
    const replaced = await fetch(`${ready.url}/api/v1/skills/skl_k8s/relations`, { method: 'PUT', headers: { 'content-type': 'application/json', 'if-match': '"v1"' }, body: JSON.stringify({ expectedVersion: 1, reason: 'remove dependency', relations: [] }) });
    expect(replaced.status).toBe(200);
    expect((await replaced.json() as { version: number }).version).toBe(2);
    child.kill('SIGTERM');
    await once(child, 'exit');
  });

  it('serves real SQLite-backed health, doctor and createMemory, then reopens persisted state', async () => {
    const root = mkdtempSync(join(repoRoot, '.tmp-rest-launcher-'));
    tempRoots.push(root);
    const dbPath = join(root, 'agent-memory.sqlite');
    const port = await allocateFreePort();
    const child = spawn(process.execPath, [bin], {
      cwd: repoRoot,
      env: { ...process.env, AGENT_MEMORY_DB_PATH: dbPath, PORT: String(port), HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    const ready = await waitReady(child);
    expect(ready.dbPath).toBe(dbPath);
    expect(ready.stderr).not.toContain('AGENT_MEMORY_BEARER_TOKEN');

    const health = await fetch(`${ready.url}/api/v1/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });

    const status = await fetch(`${ready.url}/api/v1/status`);
    expect(status.status).toBe(200);

    const doctor = await fetch(`${ready.url}/api/v1/admin/doctor`);
    expect(doctor.status).toBe(200);
    expect((await doctor.json()) as { ok?: boolean }).toBeTruthy();

    const created = await fetch(`${ready.url}/api/v1/memories`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'fact', scopeKey: 'openclaw-test', content: { marker: 'rest-launcher' }, reason: 'integration smoke' }),
    });
    expect(created.status).toBe(201);
    const memory = await created.json() as { id: string; version: number; lifecycle: string };
    expect(memory.id).toMatch(/^mem_/);
    expect(memory.version).toBe(1);
    expect(memory.lifecycle).toBe('candidate');

    const store = new SqliteStore(dbPath);
    try {
      expect(store.diagnostics().counts.memories).toBe(1);
    } finally {
      store.close();
    }

    // supersedeMemory — must carry If-Match for the route CAS precondition,
    // and body.expectedVersion for the storage layer's version check.
    const superseded = await fetch(`${ready.url}/api/v1/memories/${memory.id}/supersede`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'if-match': `"v${memory.version}"` },
      body: JSON.stringify({
        kind: 'fact',
        scopeKey: 'openclaw-test',
        content: { marker: 'rest-launcher-v2' },
        reason: 'integration smoke superseded',
        expectedVersion: memory.version,
      }),
    });
    expect(superseded.status).toBe(200);
    const replacement = await superseded.json() as { id: string; supersedesId?: string; version: number; lifecycle: string; content: { marker?: string } };
    expect(replacement.id).not.toBe(memory.id);
    expect(replacement.supersedesId).toBe(memory.id);
    expect(replacement.version).toBe(1);
    expect(replacement.lifecycle).toBe('candidate');
    expect(replacement.content.marker).toBe('rest-launcher-v2');

    // forgetMemory — exercise against the replacement row. Same route
    // CAS contract (If-Match required) and same expectedVersion check.
    const forgot = await fetch(`${ready.url}/api/v1/memories/${replacement.id}/forget`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'if-match': `"v${replacement.version}"` },
      body: JSON.stringify({ expectedVersion: replacement.version, reason: 'integration smoke forgot' }),
    });
    expect(forgot.status).toBe(200);
    const forgotten = await forgot.json() as { id: string; lifecycle: string; version: number };
    expect(forgotten.id).toBe(replacement.id);
    expect(forgotten.lifecycle).toBe('forgotten');
    expect(forgotten.version).toBe(2);

    const storeAfter = new SqliteStore(dbPath);
    try {
      // The original is still in the table at version 1, lifecycle=superseded;
      // the replacement is at version 2, lifecycle=forgotten.
      expect(storeAfter.diagnostics().counts.memories).toBe(2);
    } finally {
      storeAfter.close();
    }

    // Negative validation: missing required body fields must yield 400,
    // not 500. Covers the launcher's strict validation pass.
    const badForget = await fetch(`${ready.url}/api/v1/memories/${memory.id}/forget`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'if-match': '"v1"' },
      body: JSON.stringify({}),
    });
    expect(badForget.status).toBe(400);

    const badSupersede = await fetch(`${ready.url}/api/v1/memories/${memory.id}/supersede`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'if-match': '"v1"' },
      body: JSON.stringify({ kind: 'fact' }),
    });
    expect(badSupersede.status).toBe(400);

    child.kill('SIGTERM');
    const [code, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];
    expect(code).toBe(0);
    expect(signal).toBeNull();
  });
});
