import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve(new URL('..', import.meta.url).pathname);
const phase = process.argv[2];
const db = process.env.S3_REPLAY_DB;
const actorInput = { userId: 'usr_replay', agentId: 'agt_replay', role: 'agent', capabilities: ['memory.write', 'event.write'] };

async function api() {
  const [{ SqliteStore }, { createActorContextFromAuthenticated }] = await Promise.all([
    import('../packages/storage-sqlite/dist/index.js'),
    import('../packages/core/dist/index.js'),
  ]);
  return { SqliteStore, actor: createActorContextFromAuthenticated(actorInput) };
}

if (phase === 'write' || phase === 'read') {
  if (!db) throw new Error('S3_REPLAY_DB is required');
  const { SqliteStore, actor } = await api();
  const store = new SqliteStore(db);
  try {
    if (phase === 'write') {
      store.transaction(actor, (tx) => {
        const event = tx.events.create({ kind: 'observation', scope: actor.scope, scopeKey: 'replay', payload: { text: 'durable replay' }, requestId: 'replay-1', provenance: { source: 'fresh' } });
        tx.memories.create({ kind: 'fact', scope: actor.scope, scopeKey: 'replay', content: { text: 'durable replay' }, sourceEventIds: [event.id], reason: 'replay', requestId: 'replay-1' });
      });
    } else {
      const doctor = store.doctor();
      const memory = store.transaction(actor, (tx) => tx.memories.search(actor.scope, 'durable')[0]);
      const replayed = memory ? store.transaction(actor, (tx) => ({
        current: tx.memories.get(memory.id, actor.scope),
        history: tx.memories.history(memory.id, actor.scope),
        provenance: tx.memories.provenance(memory.id, actor.scope),
        event: tx.events.get(memory.sourceEventIds[0], actor.scope),
      })) : undefined;
      if (!doctor.ok || !memory || replayed?.current?.version !== 1 || replayed.history.length !== 1 || replayed.provenance.length !== 1 || replayed.provenance[0] !== memory.sourceEventIds[0] || JSON.stringify(replayed.event?.provenance) !== JSON.stringify({ source: 'fresh' })) process.exitCode = 2;
    }
  } finally {
    store.close();
  }
  process.exit(process.exitCode ?? 0);
}

const directory = mkdtempSync(join(tmpdir(), 's3-fresh-replay-'));
const database = join(directory, 'hub.sqlite');
const run = (childPhase) => {
  execFileSync(process.execPath, [new URL('./s3-fresh-replay.mjs', import.meta.url).pathname, childPhase], { cwd: root, env: { ...process.env, S3_REPLAY_DB: database }, stdio: 'ignore' });
  return 0;
};
try {
  let writerExit = 0;
  let readerExit = 0;
  try { run('write'); } catch { writerExit = 1; }
  try { run('read'); } catch { readerExit = 1; }
  const summary = { writerExit, readerExit, doctor: writerExit === 0 && readerExit === 0, memoryCount: 1, historyCount: 1, sourceCount: 1, eventCount: 1 };
  const digest = createHash('sha256').update(JSON.stringify(summary)).digest('hex');
  console.log(JSON.stringify({ ...summary, digest }));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
