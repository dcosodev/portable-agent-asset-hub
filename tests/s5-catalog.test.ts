import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalDigest, sanitizeMetadata, SyncService } from '@portable-agent-asset-hub/core';
import { RootScanner } from '@portable-agent-asset-hub/storage-files';

describe('S5 catalog contracts', () => {
  it('logical_key_stable', async () => {
    const temporary=realpathSync(mkdtempSync(join(tmpdir(),'s5-logical-roots-')));
    try {
      const firstA=join(temporary,'physical-a1'), firstB=join(temporary,'physical-b1');
      const movedA=join(temporary,'moved-a2'), movedB=join(temporary,'moved-b2');
      for(const root of [firstA,firstB,movedA,movedB]) { mkdirSync(root,{recursive:true}); writeFileSync(join(root,'same.md'),'same'); }
      const scope={ownerUserId:'usr_logical' as const,agentId:'agt_logical' as const};
      const scanner=new RootScanner();
      const first=await new SyncService(scanner).preview({roots:[{id:'docs-a',path:firstA},{id:'docs-b',path:firstB}],scope,profile:'default'});
      const moved=await new SyncService(scanner).preview({roots:[{id:'docs-b',path:movedB},{id:'docs-a',path:movedA}],scope,profile:'default'});
      const firstKeys=first.operations.map((operation)=>operation.logicalKey).sort();
      const movedKeys=moved.operations.map((operation)=>operation.logicalKey).sort();
      expect(firstKeys).toEqual(['document:docs-a:same.md','document:docs-b:same.md']);
      expect(movedKeys).toEqual(firstKeys);
      expect(moved.inputFingerprint).toBe(first.inputFingerprint);
      expect(moved.rootsFingerprint).not.toBe(first.rootsFingerprint);
      expect(moved.digest).not.toBe(first.digest);
    } finally { rmSync(temporary,{recursive:true,force:true}); }
  });
  it('preview_digest_deterministic', () => {
    const a = { profile: 'p', scope: { ownerUserId: 'u', agentId: 'a' }, operations: [{ logicalKey: 'x', action: 'upsert' }] };
    expect(canonicalDigest(a)).toBe(canonicalDigest({ operations: a.operations, scope: a.scope, profile: a.profile }));
  });
  it('sanitizes before identity and persistence', () => {
    expect(sanitizeMetadata({ name: ' hello ', body: 'secret body', token: 'abc' })).toEqual({ name: 'hello', token: '[REDACTED]' });
  });
  it('constructs a deterministic preview without persistence', async () => {
    const service = new SyncService({ scan: async () => [{ kind: 'document', relativePath: 'README.md', locator: 'README.md', bytes: Buffer.from('# hi') }] });
    const preview = await service.preview({ roots: ['/tmp/root'], scope: { ownerUserId: 'u', agentId: 'a' }, profile: 'default', target: { bytes: Buffer.from('target') } });
    expect(preview.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.operations).toHaveLength(1);
    const replay = await service.preview({ roots: ['/tmp/root'], scope: { ownerUserId: 'u', agentId: 'a' }, profile: 'default', target: { bytes: Buffer.from('target') } });
    expect(replay.digest).toBe(preview.digest);
    expect(replay.operations).toEqual(preview.operations);
  });
});
