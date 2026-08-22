import { mkdtempSync, rmSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createActorContextFromAuthenticated, HubError } from '@portable-agent-asset-hub/core';
import { SqliteStore } from '@portable-agent-asset-hub/storage-sqlite';

const actor = createActorContextFromAuthenticated({
  userId: 'usr_s3',
  agentId: 'agt_s3',
  role: 'agent',
  capabilities: ['memory.write', 'event.write'],
});
const other = createActorContextFromAuthenticated({
  userId: 'usr_other',
  agentId: 'agt_other',
  role: 'agent',
  capabilities: ['memory.write', 'event.write'],
});

function createBase(store: SqliteStore, context = actor) {
  return store.transaction(context, (tx) => {
    const event = tx.events.create({
      kind: 'observation',
      scope: context.scope,
      scopeKey: 'session-1',
      payload: { text: 'hello' },
      requestId: 'event-request',
      provenance: { source: 'test' },
    });
    const memory = tx.memories.create({
      kind: 'fact',
      scope: context.scope,
      scopeKey: 'memory-1',
      content: { text: 'hello' },
      sourceEventIds: [event.id],
      reason: 'capture',
      requestId: 'memory-request',
    });
    return { event, memory };
  });
}

describe('S3 memory nominal vertical slices', () => {
  it('memory_create_records_provenance_and_audit', () => {
    const store = new SqliteStore(':memory:');
    try {
      const { event, memory } = createBase(store);
      expect(event.id).toMatch(/^evt_/);
      expect(memory.id).toMatch(/^mem_/);
      expect(memory.version).toBe(1);
      expect(memory.sourceEventIds).toEqual([event.id]);
      expect(store.transaction(actor, (tx) => tx.audit.list(actor.scope))).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  it('concurrent_update_returns_conflict', () => {
    const directory = mkdtempSync(join(tmpdir(), 's3-cas-'));
    const path = join(directory, 'hub.sqlite');
    const first = new SqliteStore(path);
    const second = new SqliteStore(path);
    try {
      const { memory } = createBase(first);
      const updated = first.transaction(actor, (tx) => tx.memories.update(
        memory.id,
        { expectedVersion: 1, content: { value: 'first' }, reason: 'update', requestId: 'r1' },
        actor.scope,
      ));
      expect(updated.version).toBe(2);
      expect(() => second.transaction(actor, (tx) => tx.memories.update(
        memory.id,
        { expectedVersion: 1, content: { value: 'stale' }, reason: 'update', requestId: 'r2' },
        actor.scope,
      ))).toThrowError(HubError);
      const current = second.transaction(actor, (tx) => tx.memories.getOrThrow(memory.id, actor.scope));
      const history = second.transaction(actor, (tx) => tx.memories.history(memory.id, actor.scope));
      expect(current.version).toBe(2);
      expect(history).toHaveLength(2);
    } finally {
      first.close();
      second.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('supersede_is_atomic_and_audited', () => {
    const store = new SqliteStore(':memory:');
    try {
      const { event, memory } = createBase(store);
      expect(() => store.transaction(actor, (tx) => tx.memories.supersede(
        memory.id,
        {
          expectedVersion: 0,
          kind: 'fact',
          scope: actor.scope,
          scopeKey: 'replacement',
          content: { text: 'stale' },
          reason: 'replace',
          requestId: 'supersede-stale',
        },
        actor.scope,
      ))).toThrowError(HubError);
      const replacement = store.transaction(actor, (tx) => tx.memories.supersede(
        memory.id,
        {
          expectedVersion: 1,
          kind: 'fact',
          scope: actor.scope,
          scopeKey: 'replacement',
          content: { text: 'replacement' },
          reason: 'replace',
          requestId: 'supersede-1',
        },
        actor.scope,
      ));
      expect(replacement.supersedesId).toBe(memory.id);
      expect(replacement.sourceEventIds).toEqual([event.id]);
      expect(store.transaction(actor, (tx) => tx.memories.getOrThrow(memory.id, actor.scope)).lifecycle).toBe('superseded');
      const actions = store.transaction(actor, (tx) => tx.audit.list(actor.scope)).map((item) => item.action);
      expect(actions.filter((action) => action === 'memory.create')).toHaveLength(1);
      expect(actions.filter((action) => action === 'memory.supersede')).toHaveLength(1);
      expect(store.transaction(actor, (tx) => tx.memories.search(actor.scope, 'replacement'))).toHaveLength(1);
      expect(store.transaction(actor, (tx) => tx.memories.search(actor.scope, 'hello'))).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it('update_preserves_sources_when_undefined', () => {
    const store = new SqliteStore(':memory:');
    try {
      const { event, memory } = createBase(store);
      const updated = store.transaction(actor, (tx) => tx.memories.update(
        memory.id,
        { expectedVersion: 1, content: { text: 'updated' }, reason: 'update', requestId: 'update-1' },
        actor.scope,
      ));
      expect(updated.sourceEventIds).toEqual([event.id]);
    } finally {
      store.close();
    }
  });

  it('update_rejects_cross_scope_sources', () => {
    const store = new SqliteStore(':memory:');
    try {
      const { memory } = createBase(store);
      const otherEvent = createBase(store, other).event;
      expect(() => store.transaction(actor, (tx) => tx.memories.update(
        memory.id,
        { expectedVersion: 1, sourceEventIds: [otherEvent.id], reason: 'update', requestId: 'update-2' },
        actor.scope,
      ))).toThrowError(HubError);
    } finally {
      store.close();
    }
  });

  it('forget_first_call_is_cas_and_second_call_is_idempotent', () => {
    const store = new SqliteStore(':memory:');
    try {
      const { memory } = createBase(store);
      expect(() => store.transaction(actor, (tx) => tx.memories.forget(memory.id, 0, actor.scope))).toThrowError(HubError);
      const forgotten = store.transaction(actor, (tx) => tx.memories.forget(memory.id, 1, actor.scope));
      const replay = store.transaction(actor, (tx) => tx.memories.forget(memory.id, 1, actor.scope));
      expect(forgotten.version).toBe(2);
      expect(replay.version).toBe(2);
      expect(store.transaction(actor, (tx) => tx.audit.list(actor.scope)).filter((item) => item.action === 'memory.forget')).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('hybrid_or_fts_never_bypasses_scope', () => {
    const store = new SqliteStore(':memory:');
    try {
      createBase(store);
      createBase(store, other);
      expect(store.transaction(actor, (tx) => tx.memories.search(actor.scope, 'hello OR memory'))).toHaveLength(1);
      expect(store.transaction(actor, (tx) => tx.memories.get('mem_missing', actor.scope))).toBeUndefined();
      expect(store.transaction(actor, (tx) => tx.memories.get('mem_missing', other.scope))).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('fts_contains_only_current_active_or_candidate_heads', () => {
    const store = new SqliteStore(':memory:');
    try {
      const { memory } = createBase(store);
      store.transaction(actor, (tx) => tx.memories.update(
        memory.id,
        { expectedVersion: 1, content: { text: 'new-head' }, reason: 'update', requestId: 'update-3' },
        actor.scope,
      ));
      expect(store.transaction(actor, (tx) => tx.memories.search(actor.scope, 'hello'))).toHaveLength(0);
      expect(store.transaction(actor, (tx) => tx.memories.search(actor.scope, 'new'))).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('doctor_reports_consistent_heads_sources_and_fts', () => {
    const store = new SqliteStore(':memory:');
    try {
      createBase(store);
      const report = store.doctor();
      expect(report.ok).toBe(true);
      expect(report.checks.memoryHeads).toBe(true);
      expect(report.checks.memorySources).toBe(true);
      expect(report.checks.ftsHeadOnly).toBe(true);
    } finally {
      store.close();
    }
  });

  it('fresh_process_reopens_and_replays_memory', () => {
    let root = process.cwd();
    while (!existsSync(join(root, 'packages')) && root !== dirname(root)) root = dirname(root);
    const migrations = join(root, 'packages/storage-sqlite/dist/migrations');
    if (!existsSync(join(root, 'packages/storage-sqlite/dist/index.js')) || !existsSync(migrations)) {
      throw new Error('built S3 artifacts are required');
    }
    const output = execFileSync(process.execPath, ['scripts/s3-fresh-replay.mjs'], { cwd: root, encoding: 'utf8' }).trim();
    const result = JSON.parse(output) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(['digest', 'doctor', 'eventCount', 'historyCount', 'memoryCount', 'readerExit', 'sourceCount', 'writerExit']);
    expect(result).toMatchObject({ writerExit: 0, readerExit: 0, doctor: true, memoryCount: 1, historyCount: 1, sourceCount: 1, eventCount: 1 });
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
  });
});
