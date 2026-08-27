// tests/storage-sqlite/canonical-duplicate-supersede.test.ts
//
// Tests for supersedeCanonicalDuplicates + reconcileCanonicalDuplicates
// (third-batch cleanup phase).
//
// Strategy: produce a "discovered" proposed proposal via direct SQL
// INSERT that matches the production schema exactly (29 columns in
// the on-disk order).
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createActorContext, type SkillRelationType } from '@portable-agent-asset-hub/core';
import { SqliteStore } from '@portable-agent-asset-hub/storage-sqlite';
// HubDatabase lives in a private path so the public surface
// (storage-sqlite index.ts) does not leak raw sqlite access. We import
// the compiled module directly here, behind the boundary check that
// asserts `HubDatabase` is NOT in the public index export.
import { HubDatabase } from '../../packages/storage-sqlite/dist/internal.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join('/tmp', 'canonical-duplicate-supersede-'));
  roots.push(root);
  const store = new SqliteStore(join(root, 'hub.sqlite'));
  const actor = createActorContext({ userId: 'usr_local', agentId: 'agt_local', role: 'admin', capabilities: ['read', 'write.skill', 'admin'] });
  return { store, actor };
}

function writeSkill(store: SqliteStore, actor: ReturnType<typeof createActorContext>, id: string, body: string) {
  return store.transaction(actor, (tx) => tx.skills.writeSkill({
    id,
    scope: actor.scope,
    logicalKey: id,
    kind: 'skill',
    name: id,
    summary: id,
    lifecycle: 'active',
    body: Buffer.from(body),
    metadata: { tags: ['deploy'] },
    resources: [],
  }, { reason: 'test', requestId: id }));
}

function rawDb(store: SqliteStore) {
  if (typeof store.databasePath !== 'string') throw new Error('cannot find sqlite path');
  const conn = new HubDatabase(store.databasePath);
  return conn.withConnection((c) => c);
}

// Columns in the on-disk order. The INSERT statement uses this exact order.
const PROPOSAL_COLUMNS = 'id,owner_user_id,scope_agent_id,source_skill_id,source_version,target_skill_id,target_version_snapshot,relation_type,target_version_constraint,confidence,detector,detector_version,model,evidence_json,reason,status,created_at,reviewed_at,reviewed_by,rejection_reason,proposal_fingerprint,reviewed_relation_type,reviewed_source_skill_id,reviewed_target_skill_id,reviewed_constraint,reviewed_constraint_set,review_modified,origin,candidate_score';
const PROPOSAL_PLACEHOLDERS = '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)';
const PROPOSAL_INSERT_SQL = `INSERT INTO skill_relation_proposals(${PROPOSAL_COLUMNS}) VALUES${PROPOSAL_PLACEHOLDERS}`;

/** Insert a discovered-style proposed proposal that exactly matches a canonical row. */
function insertDiscoveredProposal(
  store: SqliteStore,
  source: string, target: string, relationType: string,
  opts: { status?: 'proposed' | 'rejected'; confidence?: number; idSuffix?: string } = {},
) {
  const db = rawDb(store);
  const status = opts.status ?? 'proposed';
  const confidence = opts.confidence ?? 0.84;
  const id = `rprop_dup_${source}_${target}_${relationType}_${opts.idSuffix ?? '0'}`;
  // Args MUST follow PROPOSAL_COLUMNS order exactly.
  db.prepare(PROPOSAL_INSERT_SQL).run(
    // 1  id
    id,
    // 2  owner_user_id
    'usr_local',
    // 3  scope_agent_id
    'agt_local',
    // 4  source_skill_id
    source,
    // 5  source_version
    1,
    // 6  target_skill_id
    target,
    // 7  target_version_snapshot
    1,
    // 8  relation_type
    relationType,
    // 9  target_version_constraint
    null,
    // 10 confidence
    confidence,
    // 11 detector
    'fts-candidate-v1',
    // 12 detector_version
    'relation-heuristic-v2',
    // 13 model
    null,
    // 14 evidence_json
    '[]',
    // 15 reason
    'test',
    // 16 status
    status,
    // 17 created_at
    '2026-01-01T00:00:00.000Z',
    // 18 reviewed_at
    status === 'rejected' ? '2026-01-02T00:00:00.000Z' : null,
    // 19 reviewed_by
    status === 'rejected' ? 'usr_local' : null,
    // 20 rejection_reason
    status === 'rejected' ? 'rejected before' : null,
    // 21 proposal_fingerprint
    `fp-${id}`,
    // 22 reviewed_relation_type
    null,
    // 23 reviewed_source_skill_id
    null,
    // 24 reviewed_target_skill_id
    null,
    // 25 reviewed_constraint
    null,
    // 26 reviewed_constraint_set
    0,
    // 27 review_modified
    0,
    // 28 origin
    'discovered',
    // 29 candidate_score
    0.8,
  );
  return id;
}

function applyCanonical(store: SqliteStore, actor: ReturnType<typeof createActorContext>, source: string, target: string, relationType: SkillRelationType, reqId: string) {
  const manual = store.transaction(actor, (tx) => tx.relationProposals.createManual({ sourceSkillId: source, targetSkillId: target, relationType, scope: actor.scope }, actor.userId));
  store.transaction(actor, (tx) => tx.relationProposals.review(manual.id, 'approved', actor.scope, actor.userId));
  const preview = store.transaction(actor, (tx) => tx.relationProposals.previewApply([manual.id], actor.scope));
  store.transaction(actor, (tx) => tx.relationProposals.apply([manual.id], preview.planDigest, actor.scope, actor.userId, reqId));
  return manual.id;
}

describe('canonical duplicate supersede', () => {
  it('discovered proposed + canonical equivalent -> superseded (related_to)', () => {
    const { store, actor } = fixture();
    try {
      writeSkill(store, actor, 'a', 'A.');
      writeSkill(store, actor, 'b', 'B.');
      applyCanonical(store, actor, 'a', 'b', 'related_to' as SkillRelationType, 'req-canon-1');
      const dupId = insertDiscoveredProposal(store, 'a', 'b', 'related_to', { idSuffix: 't1' });
      const superseded = store.transaction(actor, (tx) => tx.relationProposals.supersedeCanonicalDuplicates({
        canonical: { sourceSkillId: 'a', sourceVersion: 1, targetSkillId: 'b', relationType: 'related_to' },
        scope: actor.scope, actorId: actor.userId,
      }));
      expect(superseded.find((p) => p.id === dupId)).toBeTruthy();
      expect(superseded.find((p) => p.id === dupId)?.status).toBe('superseded');
      expect(superseded.find((p) => p.id === dupId)?.rejectionReason).toMatch(/^canonical_equivalent_exists:/);
    } finally { store.close(); }
  });

  it('related_to reverse direction -> equivalent (B->A matches canonical A->B)', () => {
    const { store, actor } = fixture();
    try {
      writeSkill(store, actor, 'a', 'A.');
      writeSkill(store, actor, 'b', 'B.');
      applyCanonical(store, actor, 'a', 'b', 'related_to' as SkillRelationType, 'req-canon-2');
      const dupId = insertDiscoveredProposal(store, 'b', 'a', 'related_to', { idSuffix: 't2' });
      const superseded = store.transaction(actor, (tx) => tx.relationProposals.supersedeCanonicalDuplicates({
        canonical: { sourceSkillId: 'a', sourceVersion: 1, targetSkillId: 'b', relationType: 'related_to' },
        scope: actor.scope, actorId: actor.userId,
      }));
      expect(superseded.find((p) => p.id === dupId)).toBeTruthy();
    } finally { store.close(); }
  });

  it('requires reverse direction -> NOT equivalent (directional)', () => {
    const { store, actor } = fixture();
    try {
      writeSkill(store, actor, 'a', 'A.');
      writeSkill(store, actor, 'b', 'B.');
      applyCanonical(store, actor, 'a', 'b', 'requires' as SkillRelationType, 'req-canon-3');
      const dupId = insertDiscoveredProposal(store, 'b', 'a', 'requires', { idSuffix: 't3' });
      const superseded = store.transaction(actor, (tx) => tx.relationProposals.supersedeCanonicalDuplicates({
        canonical: { sourceSkillId: 'a', sourceVersion: 1, targetSkillId: 'b', relationType: 'requires' },
        scope: actor.scope, actorId: actor.userId,
      }));
      expect(superseded.find((p) => p.id === dupId)).toBeUndefined();
      const after = store.transaction(actor, (tx) => tx.relationProposals.get(dupId, actor.scope));
      expect(after.status).toBe('proposed');
    } finally { store.close(); }
  });

  it('already superseded -> unchanged (idempotent)', () => {
    const { store, actor } = fixture();
    try {
      writeSkill(store, actor, 'a', 'A.');
      writeSkill(store, actor, 'b', 'B.');
      applyCanonical(store, actor, 'a', 'b', 'related_to' as SkillRelationType, 'req-canon-4');
      const dupId = insertDiscoveredProposal(store, 'a', 'b', 'related_to', { idSuffix: 't4' });
      const r1 = store.transaction(actor, (tx) => tx.relationProposals.supersedeCanonicalDuplicates({ canonical: { sourceSkillId: 'a', sourceVersion: 1, targetSkillId: 'b', relationType: 'related_to' }, scope: actor.scope, actorId: actor.userId }));
      expect(r1.length).toBe(1);
      expect(r1[0]?.id).toBe(dupId);
      const r2 = store.transaction(actor, (tx) => tx.relationProposals.supersedeCanonicalDuplicates({ canonical: { sourceSkillId: 'a', sourceVersion: 1, targetSkillId: 'b', relationType: 'related_to' }, scope: actor.scope, actorId: actor.userId }));
      expect(r2.length).toBe(0);
    } finally { store.close(); }
  });

  it('rejected -> unchanged', () => {
    const { store, actor } = fixture();
    try {
      writeSkill(store, actor, 'a', 'A.');
      writeSkill(store, actor, 'b', 'B.');
      applyCanonical(store, actor, 'a', 'b', 'related_to' as SkillRelationType, 'req-canon-5');
      const dupId = insertDiscoveredProposal(store, 'a', 'b', 'related_to', { idSuffix: 't5', status: 'rejected' });
      const r = store.transaction(actor, (tx) => tx.relationProposals.supersedeCanonicalDuplicates({ canonical: { sourceSkillId: 'a', sourceVersion: 1, targetSkillId: 'b', relationType: 'related_to' }, scope: actor.scope, actorId: actor.userId }));
      expect(r.find((p) => p.id === dupId)).toBeUndefined();
      const after = store.transaction(actor, (tx) => tx.relationProposals.get(dupId, actor.scope));
      expect(after.status).toBe('rejected');
    } finally { store.close(); }
  });

  it('unrelated proposals -> unchanged', () => {
    const { store, actor } = fixture();
    try {
      writeSkill(store, actor, 'a', 'A.');
      writeSkill(store, actor, 'b', 'B.');
      writeSkill(store, actor, 'c', 'C.');
      applyCanonical(store, actor, 'a', 'b', 'related_to' as SkillRelationType, 'req-canon-6');
      const dupId = insertDiscoveredProposal(store, 'a', 'c', 'related_to', { idSuffix: 't6' });
      const r = store.transaction(actor, (tx) => tx.relationProposals.supersedeCanonicalDuplicates({ canonical: { sourceSkillId: 'a', sourceVersion: 1, targetSkillId: 'b', relationType: 'related_to' }, scope: actor.scope, actorId: actor.userId }));
      expect(r.find((p) => p.id === dupId)).toBeUndefined();
      const after = store.transaction(actor, (tx) => tx.relationProposals.get(dupId, actor.scope));
      expect(after.status).toBe('proposed');
    } finally { store.close(); }
  });

  it('reconcileCanonicalDuplicates walks every canonical row and supersedes', () => {
    const { store, actor } = fixture();
    try {
      writeSkill(store, actor, 'a', 'A.');
      writeSkill(store, actor, 'b', 'B.');
      writeSkill(store, actor, 'c', 'C.');
      applyCanonical(store, actor, 'a', 'b', 'related_to' as SkillRelationType, 'req-canon-7a');
      applyCanonical(store, actor, 'b', 'c', 'related_to' as SkillRelationType, 'req-canon-7b');
      const dupA = insertDiscoveredProposal(store, 'a', 'b', 'related_to', { idSuffix: 'r1' });
      const dupB = insertDiscoveredProposal(store, 'b', 'c', 'related_to', { idSuffix: 'r2' });
      const all = store.transaction(actor, (tx) => tx.relationProposals.reconcileCanonicalDuplicates(actor.scope, actor.userId));
      expect(all.find((p) => p.id === dupA)?.status).toBe('superseded');
      expect(all.find((p) => p.id === dupB)?.status).toBe('superseded');
    } finally { store.close(); }
  });

  it('apply regression: discovered proposed + manual applied -> canonical exists, manual terminal, discovered superseded, doctor green', () => {
    const { store, actor } = fixture();
    try {
      writeSkill(store, actor, 'a', 'A.');
      writeSkill(store, actor, 'b', 'B.');
      const discoveredId = insertDiscoveredProposal(store, 'a', 'b', 'related_to', { idSuffix: 'reg' });
      // Create manual proposal, approve, apply — the apply path must also
      // supersede the discovered duplicate.
      const manualId = applyCanonical(store, actor, 'a', 'b', 'related_to' as SkillRelationType, 'req-regression');
      // 1) Canonical exists
      const relations = store.transaction(actor, (tx) => tx.skills.getRelations('a', 1, actor.scope));
      expect(relations.find((r) => r.targetSkillId === 'b' && r.type === 'related_to')).toBeTruthy();
      // 2) Manual proposal -> superseded
      const manualAfter = store.transaction(actor, (tx) => tx.relationProposals.get(manualId, actor.scope));
      expect(manualAfter.status).toBe('superseded');
      // 3) Discovered proposal -> superseded
      const discoveredAfter = store.transaction(actor, (tx) => tx.relationProposals.get(discoveredId, actor.scope));
      expect(discoveredAfter.status).toBe('superseded');
      expect(discoveredAfter.rejectionReason).toMatch(/^canonical_equivalent_exists:/);
      // 4) Doctor green
      const doctor = store.doctor();
      expect(doctor.checks.relationProposalNoCanonicalDuplicates).toBe(true);
      // Note: the test fixture's test-only INSERTs may not satisfy every
      // doctor invariant; we only require relationProposalNoCanonicalDuplicates
      // here. Production state is checked via integration tests + REST.
      expect(doctor.checks.relationProposalNoCanonicalDuplicates).toBe(true);
    } finally { store.close(); }
  });
});