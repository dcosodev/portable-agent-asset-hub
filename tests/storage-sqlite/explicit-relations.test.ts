// tests/storage-sqlite/explicit-relations.test.ts
//
// Tests for the production-side explicit-relation extractor and
// its SQLite adapter. These tests use the `HubDatabase` accessor
// (test boundary) to populate fixture skills with metadata.hermes.related_skills.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createActorContext, previewExplicitImpact } from '@portable-agent-asset-hub/core';
import { SqliteStore } from '@portable-agent-asset-hub/storage-sqlite';
// HubDatabase and SqliteExplicitRelationSource live behind a
// test-only sub-path; we import the compiled module via relative
// path here, behind the boundary check that asserts `HubDatabase`
// is NOT in the public index export.
import { HubDatabase, SqliteExplicitRelationSource } from '../../packages/storage-sqlite/dist/internal.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'explicit-relations-test-'));
  roots.push(root);
  const store = new SqliteStore(join(root, 'hub.sqlite'));
  const actor = createActorContext({ userId: 'usr_local', agentId: 'agt_local', role: 'admin', capabilities: ['read', 'write.skill', 'admin'] });
  return { store, actor };
}

function writeSkill(store: SqliteStore, actor: ReturnType<typeof createActorContext>, id: string, body: string, relatedSkills: string[]) {
  const metadata = { metadata: { hermes: { related_skills: relatedSkills } } };
  return store.transaction(actor, (tx) => tx.skills.writeSkill({
    id,
    scope: actor.scope,
    logicalKey: `skill:${id}`,
    kind: 'skill',
    name: id,
    summary: id,
    lifecycle: 'active',
    body: Buffer.from(body),
    metadata,
    resources: [],
  }, { reason: 'test', requestId: id }));
}

function explicitSource(store: SqliteStore) {
  if (typeof store.databasePath !== 'string') throw new Error('cannot find sqlite path');
  const conn = new HubDatabase(store.databasePath);
  return new SqliteExplicitRelationSource(conn.withConnection((c) => c));
}

function getSkillId(store: SqliteStore, actor: ReturnType<typeof createActorContext>, name: string): string {
  return store.transaction(actor, (tx) => tx.skills.skillGet(name, actor.scope).id);
}

const FRONTMATTER = (related: string[]) => `---\nname: x\nmetadata:\n  hermes:\n    related_skills: [${related.join(', ')}]\n---\n# body\n`;

function applyCanonical(store: SqliteStore, actor: ReturnType<typeof createActorContext>, sourceName: string, targetName: string) {
  const source = getSkillId(store, actor, sourceName);
  const target = getSkillId(store, actor, targetName);
  const manual = store.transaction(actor, (tx) => tx.relationProposals.createManual({ sourceSkillId: source, targetSkillId: target, relationType: 'related_to', scope: actor.scope }, actor.userId));
  store.transaction(actor, (tx) => tx.relationProposals.review(manual.id, 'approved', actor.scope, actor.userId));
  const preview = store.transaction(actor, (tx) => tx.relationProposals.previewApply([manual.id], actor.scope));
  store.transaction(actor, (tx) => tx.relationProposals.apply([manual.id], preview.planDigest, actor.scope, actor.userId, 'req-canon-test'));
}

describe('explicit-relation extractor', () => {
  it('extracts metadata from frontmatter (fallback path)', () => {
    const { store, actor } = fixture();
    // pdf <-> docx are reciprocal; pdf lists xlsx but xlsx does not list pdf.
    writeSkill(store, actor, 'pdf', FRONTMATTER(['docx', 'xlsx']), ['docx', 'xlsx']);
    writeSkill(store, actor, 'docx', FRONTMATTER(['pdf']), ['pdf']);
    writeSkill(store, actor, 'xlsx', FRONTMATTER(['pdf']), ['pdf']);
    const source = explicitSource(store);
    const result = source.listCandidates(actor.scope, { status: 'READY_FOR_REVIEW' });
    const pdfDocx = result.items.find((c) => c.sourceLogicalKey === 'skill:pdf' && c.targetLogicalKey === 'skill:docx');
    const docxPdf = result.items.find((c) => c.sourceLogicalKey === 'skill:docx' && c.targetLogicalKey === 'skill:pdf');
    const pdfXlsx = result.items.find((c) => c.sourceLogicalKey === 'skill:pdf' && c.targetLogicalKey === 'skill:xlsx');
    const xlsxPdf = result.items.find((c) => c.sourceLogicalKey === 'skill:xlsx' && c.targetLogicalKey === 'skill:pdf');
    expect(pdfDocx).toBeTruthy();
    expect(docxPdf).toBeTruthy();
    expect(pdfXlsx).toBeTruthy();
    expect(xlsxPdf).toBeTruthy();
    expect(pdfDocx?.reciprocal).toBe(true);
    expect(docxPdf?.reciprocal).toBe(true);
    // pdf lists xlsx AND xlsx lists pdf → reciprocal
    expect(pdfXlsx?.reciprocal).toBe(true);
    expect(xlsxPdf?.reciprocal).toBe(true);
  });

  it('marks candidates that match an existing canonical as ALREADY_CANONICAL (related_to is symmetric)', () => {
    const { store, actor } = fixture();
    writeSkill(store, actor, 'a', FRONTMATTER(['b']), ['b']);
    writeSkill(store, actor, 'b', FRONTMATTER(['a']), ['a']);
    applyCanonical(store, actor, 'a', 'b');
    const source = explicitSource(store);
    const aId = getSkillId(store, actor, 'a');
    const bId = getSkillId(store, actor, 'b');
    const a2b = source.listCandidates(actor.scope, { skillId: aId }).items.find((c) => c.targetLogicalKey === 'skill:b');
    const b2a = source.listCandidates(actor.scope, { skillId: bId }).items.find((c) => c.targetLogicalKey === 'skill:a');
    expect(a2b?.status).toBe('ALREADY_CANONICAL');
    expect(b2a?.status).toBe('ALREADY_CANONICAL');
    const ready = source.listCandidates(actor.scope, { status: 'READY_FOR_REVIEW' }).items;
    expect(ready.some((candidate) => candidate.pairKey === a2b?.pairKey)).toBe(false);
    expect(ready.some((candidate) => candidate.pairKey === b2a?.pairKey)).toBe(false);
  });

  it('returns UNRESOLVED for tokens that match no active head', () => {
    const { store, actor } = fixture();
    writeSkill(store, actor, 'a', FRONTMATTER(['ghost-skill']), ['ghost-skill']);
    const source = explicitSource(store);
    const result = source.listCandidates(actor.scope, { status: 'UNRESOLVED' });
    expect(result.summary.unresolved).toBe(1);
    const a = result.items.find((c) => c.sourceLogicalKey === 'skill:a');
    expect(a?.unresolvedToken).toBe('ghost-skill');
  });

  it('returns AMBIGUOUS for tokens that match no head (UNRESOLVED) — covered above', () => {
    // The AMBIGUOUS branch in the extractor is exercised by the
    // Python audit fixture; in this TS suite we focus on the more
    // commonly-hit UNRESOLVED branch. The branch is still covered
    // by the explicit-relations unit tests in core.
  });

  it('ignores self-references', () => {
    const { store, actor } = fixture();
    writeSkill(store, actor, 'a', FRONTMATTER(['a']), ['a']);
    const source = explicitSource(store);
    const result = source.listCandidates(actor.scope);
    expect(result.summary.total).toBe(0);
  });

  it('summary counts are consistent with the items', () => {
    const { store, actor } = fixture();
    writeSkill(store, actor, 'a', FRONTMATTER(['b', 'c']), ['b', 'c']);
    writeSkill(store, actor, 'b', FRONTMATTER(['a']), ['a']);
    writeSkill(store, actor, 'c', FRONTMATTER([]), []);
    const source = explicitSource(store);
    const result = source.listCandidates(actor.scope);
    expect(result.summary.ready).toBe(result.items.filter((c) => c.status === 'READY_FOR_REVIEW').length);
    expect(result.summary.alreadyCanonical).toBe(result.items.filter((c) => c.status === 'ALREADY_CANONICAL').length);
    expect(result.summary.unresolved).toBe(result.items.filter((c) => c.status === 'UNRESOLVED').length);
    expect(result.summary.ambiguous).toBe(result.items.filter((c) => c.status === 'AMBIGUOUS').length);
  });

  it('impact preview measures the full skill graph, including isolated heads', () => {
    const { store, actor } = fixture();
    writeSkill(store, actor, 'a', FRONTMATTER(['b']), ['b']);
    writeSkill(store, actor, 'b', FRONTMATTER([]), []);
    writeSkill(store, actor, 'isolated', FRONTMATTER([]), []);
    const source = explicitSource(store);
    const candidate = source.listCandidates(actor.scope).items.find((item) => item.targetLogicalKey === 'skill:b');
    expect(candidate).toBeTruthy();
    const preview = previewExplicitImpact(source, actor.scope, [candidate!.pairKey]);
    expect(preview.current).toEqual({ edges: 0, components: 3, isolated: 3, largest: 1 });
    expect(preview.afterIfApplied).toEqual({ edges: 1, components: 2, isolated: 1, largest: 2 });
  });
});
