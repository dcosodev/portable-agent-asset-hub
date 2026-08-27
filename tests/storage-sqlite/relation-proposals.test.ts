import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createActorContext } from '@portable-agent-asset-hub/core';
import { SqliteStore } from '@portable-agent-asset-hub/storage-sqlite';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() { const root = mkdtempSync(join('/tmp', 'relation-proposals-')); roots.push(root); const store = new SqliteStore(join(root, 'hub.sqlite')); const actor = createActorContext({ userId: 'u', agentId: 'a', role: 'admin', capabilities: ['read', 'write.skill', 'admin'] }); return { store, actor }; }
function write(store: SqliteStore, actor: ReturnType<typeof createActorContext>, id: string, body: string, expectedVersion?: number) { return store.transaction(actor, (tx) => tx.skills.writeSkill({ id, scope: actor.scope, logicalKey: id, kind: 'skill', name: id, summary: id, lifecycle: 'active', body: Buffer.from(body), metadata: { tags: ['deploy'] }, resources: [], ...(expectedVersion === undefined ? {} : { expectedVersion }) }, { reason: 'test', requestId: `${id}-${expectedVersion ?? 0}` })); }

describe('sqlite relation proposals', () => {
  it('discovers durable proposals without writing canonical relations and suppresses duplicates', () => {
    const { store, actor } = fixture();
    try {
      write(store, actor, 'aws-auth', 'Authenticate AWS.');
      write(store, actor, 'deploy-eks', 'Use aws-auth before deploying EKS.');
      const first = store.transaction(actor, (tx) => tx.relationProposals.discover(actor.scope, { topK: 8 }));
      expect(first.proposals.some((p) => p.sourceSkillId === 'deploy-eks' && p.targetSkillId === 'aws-auth' && p.relationType === 'requires')).toBe(true);
      expect(store.transaction(actor, (tx) => tx.skills.getRelations('deploy-eks', 1, actor.scope))).toEqual([]);
      const second = store.transaction(actor, (tx) => tx.relationProposals.discover(actor.scope));
      expect(second.proposals).toHaveLength(0);
      expect(store.doctor().checks.relationProposalStoreHealthy).toBe(true);
    } finally { store.close(); }
  });
  it('requires review and digest before transactional canonical apply', () => {
    const { store, actor } = fixture();
    try {
      write(store, actor, 'aws-auth', 'Authenticate AWS.');
      write(store, actor, 'deploy-eks', 'Use aws-auth before deploying EKS.');
      const proposal = store.transaction(actor, (tx) => tx.relationProposals.discover(actor.scope).proposals.find((p) => p.sourceSkillId === 'deploy-eks' && p.targetSkillId === 'aws-auth')!);
      expect(() => store.transaction(actor, (tx) => tx.relationProposals.apply([proposal.id], 'bad', actor.scope, actor.userId, 'req'))).toThrow();
      store.transaction(actor, (tx) => tx.relationProposals.review(proposal.id, 'approved', actor.scope, actor.userId));
      const preview = store.transaction(actor, (tx) => tx.relationProposals.previewApply([proposal.id], actor.scope));
      store.transaction(actor, (tx) => tx.relationProposals.apply([proposal.id], preview.planDigest, actor.scope, actor.userId, 'req'));
      expect(store.transaction(actor, (tx) => tx.skills.getRelations('deploy-eks', 1, actor.scope))).toHaveLength(1);
      expect(store.transaction(actor, (tx) => tx.relationProposals.get(proposal.id, actor.scope).status)).toBe('superseded');
    } finally { store.close(); }
  });
  it('applies reviewed relation type, direction and constraint rather than original suggestion', () => {
    const { store, actor } = fixture();
    try {
      write(store, actor, 'aws-auth', 'Authenticate AWS.'); write(store, actor, 'deploy-eks', 'Use aws-auth before deploying EKS.');
      const proposal = store.transaction(actor, (tx) => tx.relationProposals.discover(actor.scope).proposals.find((p) => p.sourceSkillId === 'deploy-eks' && p.targetSkillId === 'aws-auth')!);
      store.transaction(actor, (tx) => tx.relationProposals.review(proposal.id, 'approved', actor.scope, actor.userId, undefined, { relationType: 'uses', reverseDirection: true, constraint: null }));
      const preview = store.transaction(actor, (tx) => tx.relationProposals.previewApply([proposal.id], actor.scope));
      expect(preview.changes[0]).toMatchObject({ sourceSkillId: 'aws-auth', targetSkillId: 'deploy-eks', relationType: 'uses', targetVersionConstraint: null });
      store.transaction(actor, (tx) => tx.relationProposals.apply([proposal.id], preview.planDigest, actor.scope, actor.userId, 'req-reviewed'));
      expect(store.transaction(actor, (tx) => tx.skills.getRelations('aws-auth', 1, actor.scope))).toEqual([expect.objectContaining({ type: 'uses', targetSkillId: 'deploy-eks' })]);
      expect(store.transaction(actor, (tx) => tx.skills.getRelations('deploy-eks', 1, actor.scope))).toEqual([]);
    } finally { store.close(); }
  });

  it('stages manual relations, rejects self relations and preserves manual provenance', () => {
    const { store, actor } = fixture();
    try {
      write(store, actor, 'source', 'Source.'); write(store, actor, 'target', 'Target.');
      const proposal = store.transaction(actor, (tx) => tx.relationProposals.createManual({ sourceSkillId: 'source', targetSkillId: 'target', relationType: 'uses', scope: actor.scope }, actor.userId));
      expect(proposal.origin).toBe('manual');
      expect(() => store.transaction(actor, (tx) => tx.relationProposals.createManual({ sourceSkillId: 'source', targetSkillId: 'source', relationType: 'uses', scope: actor.scope }, actor.userId))).toThrow();
      const approved = store.transaction(actor, (tx) => tx.relationProposals.review(proposal.id, 'approved', actor.scope, actor.userId));
      const preview = store.transaction(actor, (tx) => tx.relationProposals.previewApply([approved.id], actor.scope));
      store.transaction(actor, (tx) => tx.relationProposals.apply([approved.id], preview.planDigest, actor.scope, actor.userId, 'req-manual'));
      expect(store.transaction(actor, (tx) => tx.skills.getRelations('source', 1, actor.scope)[0]?.metadata)).toEqual(expect.objectContaining({ origin: 'manual_reviewed', proposalId: proposal.id }));
    } finally { store.close(); }
  });

  it('changes the digest when reviewed effective values change', () => {
    const { store, actor } = fixture();
    try {
      write(store, actor, 'a', 'A.'); write(store, actor, 'b', 'B.');
      const proposal = store.transaction(actor, (tx) => tx.relationProposals.createManual({ sourceSkillId: 'a', targetSkillId: 'b', relationType: 'requires', scope: actor.scope }, actor.userId));
      const original = store.transaction(actor, (tx) => tx.relationProposals.previewApply([proposal.id], actor.scope));
      expect(original.changes[0]).toMatchObject({ sourceSkillId: 'a', targetSkillId: 'b', relationType: 'requires' });
      store.transaction(actor, (tx) => tx.relationProposals.review(proposal.id, 'approved', actor.scope, actor.userId, undefined, { relationType: 'uses', reverseDirection: true }));
      const reviewed = store.transaction(actor, (tx) => tx.relationProposals.previewApply([proposal.id], actor.scope));
      expect(reviewed.changes[0]).toMatchObject({ sourceSkillId: 'b', targetSkillId: 'a', relationType: 'uses' });
      expect(reviewed.planDigest).not.toBe(original.planDigest);
    } finally { store.close(); }
  });

  it('uses a different digest and clears a reviewed constraint on apply', () => {
    const { store, actor } = fixture();
    try {
      write(store, actor, 'source', 'Source.'); write(store, actor, 'target', 'Target.');
      const proposal = store.transaction(actor, (tx) => tx.relationProposals.createManual({ sourceSkillId: 'source', targetSkillId: 'target', relationType: 'requires', constraint: '>=3', scope: actor.scope }, actor.userId));
      store.transaction(actor, (tx) => tx.relationProposals.review(proposal.id, 'approved', actor.scope, actor.userId, undefined, { constraint: null }));
      const preview = store.transaction(actor, (tx) => tx.relationProposals.previewApply([proposal.id], actor.scope));
      expect(preview.changes[0]?.targetVersionConstraint).toBeNull();
      expect(preview.planDigest).not.toBe('');
      store.transaction(actor, (tx) => tx.relationProposals.apply([proposal.id], preview.planDigest, actor.scope, actor.userId, 'req-constraint'));
      expect(store.transaction(actor, (tx) => tx.skills.getRelations('source', 1, actor.scope)[0])).toEqual(expect.objectContaining({ targetVersionConstraint: null }));
    } finally { store.close(); }
  });

  it('does not allow batch accept-as-suggested to overwrite an edited proposal', () => {
    const { store, actor } = fixture();
    try {
      write(store, actor, 'source', 'Source.'); write(store, actor, 'target', 'Target.');
      const proposal = store.transaction(actor, (tx) => tx.relationProposals.createManual({ sourceSkillId: 'source', targetSkillId: 'target', relationType: 'requires', scope: actor.scope }, actor.userId));
      store.transaction(actor, (tx) => tx.relationProposals.review(proposal.id, 'approved', actor.scope, actor.userId, undefined, { relationType: 'uses' }));
      const persisted = store.transaction(actor, (tx) => tx.relationProposals.get(proposal.id, actor.scope));
      expect(persisted.reviewModified).toBe(true);
      expect(persisted.reviewedRelationType).toBe('uses');
    } finally { store.close(); }
  });

  it("marks approved proposals stale when a source head changes", () => {
    const { store, actor } = fixture();
    try {
      write(store, actor, 'aws-auth', 'Authenticate AWS.');
      write(store, actor, 'deploy-eks', 'Use aws-auth before deploying EKS.');
      const proposal = store.transaction(actor, (tx) => tx.relationProposals.discover(actor.scope).proposals.find((p) => p.sourceSkillId === 'deploy-eks')!);
      store.transaction(actor, (tx) => tx.relationProposals.review(proposal.id, 'approved', actor.scope, actor.userId));
      write(store, actor, 'deploy-eks', 'Use aws-auth before deploying EKS, now revised.', 1);
      const preview = store.transaction(actor, (tx) => tx.relationProposals.previewApply([proposal.id], actor.scope));
      expect(() => store.transaction(actor, (tx) => tx.relationProposals.apply([proposal.id], preview.planDigest, actor.scope, actor.userId, 'req'))).toThrow();
      expect(store.transaction(actor, (tx) => tx.relationProposals.get(proposal.id, actor.scope).status)).toBe('stale');
    } finally { store.close(); }
  });
});
