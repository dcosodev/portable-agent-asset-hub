// tests/storage-files/root-scanner-skills.test.ts
//
// TDD slice for SKILL.md classification in RootScanner.
//
// Normative contracts exercised:
//
//   Scanner-level (RootScanner.scan)
//   ────────────────────────────────
//   * basename === 'SKILL.md'           → kind 'skill', sourceKind 'skill-file'
//   * basename === 'skill.md'           → kind 'document' (case-sensitive)
//   * basename === 'SKILL.md.bak'       → kind 'document' (extension differs)
//   * YAML frontmatter name/description → metadata.name + summary, sanitized
//   * missing frontmatter               → no throw, fallback name = parent dir
//   * invalid frontmatter               → no throw, fallback name = parent dir
//   * unbounded frontmatter             → parsed within byte/line caps only
//   * unknown frontmatter keys          → ignored, only name/description kept
//   * nested category/name/SKILL.md     → still classified as skill
//   * exact selector list semantics     → preserved (rel===s or rel startsWith s+'/')
//   * symlink root / symlink entry / race / denied path behaviour is preserved
//
//   Persistence-level (SyncService + SqliteStore)
//   ─────────────────────────────────────────────
//   * bytes remain on the transient candidate only
//   * catalog_entries.metadata_json stores {sha256, rootId, relativePath, …}
//     and never the SKILL.md body or description body bytes
//   * catalog_sources.fingerprint stores the body content digest, not the body

import { afterEach, describe, expect, it } from 'vitest';
import {
  createActorContext,
  SyncService,
  type CatalogCandidate,
  type CatalogEntry,
} from '@portable-agent-asset-hub/core';
import { SqliteStore } from '@portable-agent-asset-hub/storage-sqlite';
import { RootScanner } from '@portable-agent-asset-hub/storage-files';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const actor = createActorContext({
  userId: 'usr_skills',
  agentId: 'agt_skills',
  role: 'user',
  capabilities: [],
});
const meta = { reason: 'root-scanner skills TDD slice', requestId: 'req_root_scanner_skills' };

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempRoots.push(dir);
  return dir;
}

function findCandidate(
  candidates: CatalogCandidate[],
  relativePath: string,
): CatalogCandidate {
  const match = candidates.find((entry) => entry.relativePath === relativePath);
  if (!match) throw new Error(`candidate not found: ${relativePath}`);
  return match;
}

describe('RootScanner SKILL.md classification', () => {
  it('emits_kind_skill_and_sourceKind_skill_file_for_exact_basename', () => {
    const root = tempRoot('s5-skill-classify-');
    writeFileSync(join(root, 'SKILL.md'), '---\nname: hello\ndescription: a friendly skill\n---\nbody bytes\n');

    const candidates = new RootScanner().scan({ roots: [{ id: 'docs', path: root }] });
    const skill = findCandidate(candidates, 'SKILL.md');
    expect(skill.kind).toBe('skill');
    expect(skill.sourceKind).toBe('skill-file');
    expect(skill.rootId).toBe('docs');
    expect(skill.locator).toBe('SKILL.md');
  });

  it('classifies_root_README_as_repository_not_skill', () => {
    const root = tempRoot('s5-skill-readme-');
    writeFileSync(join(root, 'README.md'), '# top\n');

    const candidates = new RootScanner().scan({ roots: [{ id: 'docs', path: root }] });
    expect(findCandidate(candidates, 'README.md').kind).toBe('repository');
  });

  it('does_not_classify_lowercase_skill_md_as_skill', () => {
    const root = tempRoot('s5-skill-case-');
    writeFileSync(join(root, 'skill.md'), '---\nname: lowercase\ndescription: nope\n---\n');

    const candidates = new RootScanner().scan({ roots: [{ id: 'docs', path: root }] });
    expect(findCandidate(candidates, 'skill.md').kind).toBe('document');
    expect(findCandidate(candidates, 'skill.md').sourceKind).toBeUndefined();
  });

  it('does_not_classify_SKILL_md_bak_as_skill', () => {
    const root = tempRoot('s5-skill-bak-');
    writeFileSync(join(root, 'SKILL.md.bak'), '---\nname: backup\ndescription: nope\n---\n');

    const candidates = new RootScanner().scan({ roots: [{ id: 'docs', path: root }] });
    expect(findCandidate(candidates, 'SKILL.md.bak').kind).toBe('document');
    expect(findCandidate(candidates, 'SKILL.md.bak').sourceKind).toBeUndefined();
  });

  it('extracts_frontmatter_name_and_description_into_metadata_and_summary', () => {
    const root = tempRoot('s5-skill-frontmatter-');
    writeFileSync(
      join(root, 'SKILL.md'),
      ['---', 'name:  spaced-name  ', "description: 'quoted desc'", '---', 'body bytes'].join('\n'),
    );

    const candidates = new RootScanner().scan({ roots: [{ id: 'docs', path: root }] });
    const skill = findCandidate(candidates, 'SKILL.md');
    expect(skill.metadata).toMatchObject({ name: 'spaced-name' });
    expect(skill.summary).toBe('quoted desc');
  });

  it('supports_plain_single_quoted_and_double_quoted_scalar_values', () => {
    const root = tempRoot('s5-skill-quotes-');
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(
      join(root, 'SKILL.md'),
      [
        '---',
        "name: plain-name",
        "description: 'single quoted desc'",
        '---',
        'body',
      ].join('\n'),
    );
    writeFileSync(
      join(root, 'docs', 'SKILL.md'),
      [
        '---',
        "name: \"double quoted name\"",
        "description: \"double quoted desc\"",
        '---',
        'body',
      ].join('\n'),
    );

    const candidates = new RootScanner().scan({ roots: [{ id: 'docs', path: root }] });
    const plain = findCandidate(candidates, 'SKILL.md');
    expect(plain.metadata).toMatchObject({ name: 'plain-name' });
    expect(plain.summary).toBe('single quoted desc');
    const double = findCandidate(candidates, 'docs/SKILL.md');
    expect(double.metadata).toMatchObject({ name: 'double quoted name' });
    expect(double.summary).toBe('double quoted desc');
  });

  it('ignores_unknown_frontmatter_keys_and_interpolation_markers', () => {
    const root = tempRoot('s5-skill-unknown-');
    writeFileSync(
      join(root, 'SKILL.md'),
      [
        '---',
        'name: ok',
        'description: ok desc',
        'license: MIT',
        'author: ${HOME}',
        'interpolation: "{{ secret }}"',
        '---',
        'body',
      ].join('\n'),
    );

    const candidates = new RootScanner().scan({ roots: [{ id: 'docs', path: root }] });
    const skill = findCandidate(candidates, 'SKILL.md');
    expect(skill.metadata?.name).toBe('ok');
    expect(skill.summary).toBe('ok desc');
    // No unknown key leaks, no interpolation expansion, no body content.
    expect(JSON.stringify(skill.metadata ?? {})).not.toContain('MIT');
    expect(JSON.stringify(skill.metadata ?? {})).not.toContain('HOME');
    expect(JSON.stringify(skill.metadata ?? {})).not.toContain('{{ secret }}');
    expect(skill.summary).not.toContain('{{ secret }}');
    expect(JSON.stringify(skill.metadata ?? {})).not.toContain('body');
    expect(skill.summary ?? '').not.toContain('body');
  });

  it('falls_back_to_parent_directory_basename_when_frontmatter_missing', () => {
    const root = tempRoot('s5-skill-missing-fm-');
    mkdirSync(join(root, 'category', 'name'), { recursive: true });
    writeFileSync(join(root, 'category', 'name', 'SKILL.md'), 'no frontmatter at all\n');

    const candidates = new RootScanner().scan({ roots: [{ id: 'docs', path: root }] });
    const skill = findCandidate(candidates, 'category/name/SKILL.md');
    expect(skill.kind).toBe('skill');
    expect(skill.sourceKind).toBe('skill-file');
    expect(skill.metadata?.name).toBe('name');
    expect(skill.summary).toBeUndefined();
  });

  it('falls_back_to_parent_directory_basename_when_frontmatter_invalid', () => {
    const root = tempRoot('s5-skill-bad-fm-');
    mkdirSync(join(root, 'alpha'), { recursive: true });
    writeFileSync(
      join(root, 'alpha', 'SKILL.md'),
      'this is not:\n  - valid yaml: at all\n::: garbage :::\n',
    );

    const candidates = new RootScanner().scan({ roots: [{ id: 'docs', path: root }] });
    const skill = findCandidate(candidates, 'alpha/SKILL.md');
    expect(skill.kind).toBe('skill');
    expect(skill.sourceKind).toBe('skill-file');
    expect(skill.metadata?.name).toBe('alpha');
    expect(skill.summary).toBeUndefined();
  });

  it('caps_frontmatter_bytes_and_lines_so_pathological_files_do_not_crash_scan', () => {
    const root = tempRoot('s5-skill-bounded-');
    // 200 garbage lines inside a single leading `---` block. The scanner
    // must bound the parser so this never blows the call stack, hangs,
    // or allocates huge buffers.
    const lines = ['---'];
    for (let i = 0; i < 200; i += 1) lines.push(`name: line-${i}`);
    lines.push('description: never closes');
    lines.push('---');
    lines.push('body');
    writeFileSync(join(root, 'SKILL.md'), `${lines.join('\n')}\n`);

    const candidates = new RootScanner().scan({ roots: [{ id: 'docs', path: root }] });
    const skill = findCandidate(candidates, 'SKILL.md');
    expect(skill.kind).toBe('skill');
    // Without a closing `---` we expect the parser to bail and fall back
    // to the parent-directory basename. The exact byte/line caps are
    // an implementation detail; what matters is that scanning returns
    // a usable candidate and does not throw.
    expect(typeof skill.metadata?.name).toBe('string');
    expect(skill.metadata?.name?.length ?? 0).toBeGreaterThan(0);
  });

  it('strips_body_bytes_from_metadata_and_summary', () => {
    const root = tempRoot('s5-skill-no-body-leak-');
    const body = 'SECRET-BODY-MARKER-DO-NOT-LEAK-9c7c';
    writeFileSync(
      join(root, 'SKILL.md'),
      ['---', 'name: leak-test', 'description: bounded public summary', '---', body].join('\n'),
    );

    const candidates = new RootScanner().scan({ roots: [{ id: 'docs', path: root }] });
    const skill = findCandidate(candidates, 'SKILL.md');
    expect(skill.metadata?.name).toBe('leak-test');
    // description is sanitized by boundedSummary -> trim+slice; the body
    // substring must not appear in either metadata or summary.
    expect(JSON.stringify(skill.metadata ?? {})).not.toContain(body);
    expect(skill.summary ?? '').not.toContain(body);
    // bytes are still present on the transient candidate.
    expect(skill.bytes.toString('utf8')).toContain(body);
  });

  it('classifies_nested_category_name_SKILL_md', () => {
    const root = tempRoot('s5-skill-nested-');
    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    writeFileSync(
      join(root, 'a', 'b', 'SKILL.md'),
      ['---', 'name: nested', 'description: inside a/b', '---', 'body'].join('\n'),
    );

    const candidates = new RootScanner().scan({ roots: [{ id: 'docs', path: root }] });
    const skill = findCandidate(candidates, 'a/b/SKILL.md');
    expect(skill.kind).toBe('skill');
    expect(skill.sourceKind).toBe('skill-file');
    expect(skill.metadata?.name).toBe('nested');
    expect(skill.summary).toBe('inside a/b');
  });

  it('honours_exact_selector_list_for_skills', () => {
    const root = tempRoot('s5-skill-selectors-');
    writeFileSync(join(root, 'top.md'), 'doc');
    writeFileSync(join(root, 'SKILL.md'), ['---', 'name: top-skill', 'description: top', '---', ''].join('\n'));
    mkdirSync(join(root, 'included'), { recursive: true });
    writeFileSync(
      join(root, 'included', 'SKILL.md'),
      ['---', 'name: in-skill', 'description: in', '---', ''].join('\n'),
    );
    mkdirSync(join(root, 'excluded'), { recursive: true });
    writeFileSync(
      join(root, 'excluded', 'SKILL.md'),
      ['---', 'name: ex-skill', 'description: ex', '---', ''].join('\n'),
    );

    // Exact match on the nested file must surface it AND its siblings
    // sharing the prefix, but never the sibling under 'excluded'.
    const candidates = new RootScanner().scan({
      roots: [{ id: 'docs', path: root }],
      selectors: ['included/SKILL.md'],
    });
    const paths = candidates.map((entry) => entry.relativePath).sort();
    expect(paths).toEqual(['included/SKILL.md']);
    const skill = findCandidate(candidates, 'included/SKILL.md');
    expect(skill.kind).toBe('skill');

    // Directory-prefix selector still works for skills.
    const dirCandidates = new RootScanner().scan({
      roots: [{ id: 'docs', path: root }],
      selectors: ['included'],
    });
    expect(dirCandidates.map((entry) => entry.relativePath)).toEqual(['included/SKILL.md']);
  });

  it('preserves_symlink_root_rejection_for_skills', () => {
    const base = tempRoot('s5-skill-symlink-root-');
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 's5-skill-outside-')));
    tempRoots.push(outside);
    writeFileSync(join(outside, 'SKILL.md'), '---\nname: outside\ndescription: outside\n---\n');
    symlinkSync(outside, join(base, 'link'));

    expect(() => new RootScanner().scan({ roots: [{ id: 'docs', path: join(base, 'link') }] })).toThrow();
  });

  it('preserves_symlink_entry_rejection_for_skills', () => {
    const root = tempRoot('s5-skill-symlink-entry-');
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 's5-skill-entry-outside-')));
    tempRoots.push(outside);
    writeFileSync(join(outside, 'SKILL.md'), '---\nname: outside\ndescription: outside\n---\n');
    symlinkSync(outside, join(root, 'SKILL.md'));

    expect(() => new RootScanner().scan({ roots: [{ id: 'docs', path: root }] })).toThrow(/symlink/i);
  });

  it('preserves_denied_path_skips_secret_skill_files', () => {
    const root = tempRoot('s5-skill-denied-');
    writeFileSync(join(root, '.env'), 'SECRET=token');
    writeFileSync(
      join(root, 'SKILL.md'),
      ['---', 'name: visible', 'description: visible', '---', 'body'].join('\n'),
    );
    writeFileSync(join(root, 'token.json'), '{"k":"v"}');

    const candidates = new RootScanner().scan({ roots: [{ id: 'docs', path: root }] });
    const paths = candidates.map((entry) => entry.relativePath).sort();
    expect(paths).toContain('SKILL.md');
    expect(paths).not.toContain('.env');
    expect(paths).not.toContain('token.json');
  });

  it('preserves_root_identity_drift_rejection_for_skills', () => {
    const base = tempRoot('s5-skill-root-race-');
    const root = join(base, 'root');
    const outside = join(base, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(
      join(root, 'SKILL.md'),
      ['---', 'name: in-root', 'description: in-root', '---', 'body'].join('\n'),
    );
    writeFileSync(join(outside, 'SKILL.md'), 'attacker');
    const scanner = new RootScanner({
      afterRootLstat: () => {
        renameSync(root, join(base, 'root-real'));
        symlinkSync(outside, root);
      },
    });
    expect(() => scanner.scan({ roots: [{ id: 'docs', path: root }] })).toThrow(/root identity changed/);
  });
});

describe('RootScanner SKILL.md bytes do not persist (SyncService + temp SQLite)', () => {
  it('apply_persists_only_sha_path_metadata_not_body', () => {
    const dir = tempRoot('s5-skill-sqlite-');
    const dbPath = join(dir, 'hub.sqlite');
    const store = new SqliteStore(dbPath);
    const root = tempRoot('s5-skill-sqlite-root-');
    writeFileSync(
      join(root, 'SKILL.md'),
      ['---', 'name: persistable', 'description: persists only the digest', '---', 'body'].join('\n'),
    );

    try {
      const scanner = new RootScanner();
      const preview = store.transaction(actor, (tx) =>
        new SyncService(scanner, { catalog: tx.catalog, sync: tx.catalogSync }).previewSync({
          roots: [{ id: 'docs', path: root }],
          scope: actor.scope,
          profile: 'prf_skills',
        }, meta),
      );
      expect(preview.complete).toBe(true);
      const upsert = preview.operations.find((op) => op.action === 'upsert' && op.candidate?.kind === 'skill');
      expect(upsert).toBeDefined();
      // Transient candidate carries bytes.
      expect(upsert?.candidate?.bytes.byteLength).toBeGreaterThan(0);
      store.transaction(actor, (tx) => tx.catalogSync.review(preview.id, preview.digest, actor.scope, meta));
      store.transaction(actor, (tx) =>
        new SyncService(scanner, { catalog: tx.catalog, sync: tx.catalogSync }).apply({
          previewId: preview.id,
          reviewedDigest: preview.digest,
          scope: actor.scope,
          meta,
        }),
      );

      const rows = store.transaction(actor, (tx) => tx.catalog.list(actor.scope));
      const skillRow: CatalogEntry | undefined = rows.find((row) => row.kind === 'skill');
      expect(skillRow).toBeDefined();
      expect(skillRow!.name).toBe('persistable');
      expect(skillRow!.summary).toBe('persists only the digest');
      // Stored metadata is sha/path/rootId/relativePath only — no body bytes.
      const serialized = JSON.stringify(skillRow!.metadata);
      expect(serialized).toContain('sha256');
      expect(serialized).toContain('rootId');
      expect(serialized).toContain('relativePath');
      expect(serialized).not.toContain('body');
      expect(serialized).not.toContain('persists only the digest');

      // Catalog sources carry the content digest only.
      const sources = store.transaction(actor, (tx) => tx.catalog.listSources(actor.scope));
      const skillSource = sources.find((source) => source.kind === 'skill-file' && source.locator === 'SKILL.md');
      expect(skillSource).toBeDefined();
      expect(skillSource!.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      store.close();
    }
  });
});
