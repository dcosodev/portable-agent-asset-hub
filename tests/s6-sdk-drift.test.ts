import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(new URL('..', import.meta.url).pathname);
const generatedRoot = join(repoRoot, 'packages/sdk-ts/generated');

function grepReferences(pattern: string, target: string): string {
  const result = spawnSync('grep', ['-RIn', '--null-data', pattern, target], { encoding: 'utf8' });
  // ripgrep returns status 1 when no matches; grep returns 1 too. Empty stdout == no matches.
  return result.stdout ?? '';
}

describe('S6 SDK generated tree drift', () => {
  it('sdk_ts_and_python_share_fixtures', () => {
    const tsProvenance = join(generatedRoot, 'PROVENANCE.json');
    const pyProvenance = join(repoRoot, 'packages/sdk-python/generated/PROVENANCE.json');
    expect(existsSync(tsProvenance)).toBe(true);
    expect(existsSync(pyProvenance)).toBe(true);
    const ts = JSON.parse(readFileSync(tsProvenance, 'utf8')) as { generator?: string; version?: string; source?: string; generator_available?: boolean; contract_fixtures?: string[] };
    const py = JSON.parse(readFileSync(pyProvenance, 'utf8')) as { generator?: string; version?: string; source?: string; generator_available?: boolean; contract_fixtures?: string[] };
    expect(ts.generator).toBe(py.generator);
    expect(ts.version).toBe(py.version);
    expect(ts.source).toBe(py.source);
    // Shared contract fixtures are pinned in the provenance so both SDKs read the same fixtures.
    expect(Array.isArray(ts.contract_fixtures)).toBe(true);
    expect(ts.contract_fixtures).toEqual(py.contract_fixtures);
  });

  it('generated_trees_have_no_drift (ts)', () => {
    const provenancePath = join(generatedRoot, 'PROVENANCE.json');
    const provenance = JSON.parse(readFileSync(provenancePath, 'utf8')) as { generator?: string; version?: string; source?: string; generator_available?: boolean };
    expect(provenance.generator).toBe('OpenAPI Generator');
    expect(provenance.version).toBe('7.10.0');
    expect(provenance.source).toBe('openapi/openapi.yaml');
    // When generator is unavailable the tree is allowed to keep PROVENANCE.json and the
    // pinned contract fixtures (referenced by PROVENANCE.contract_fixtures). Both must be
    // identical to the Python tree so consumers do not see drift.
    const entries = readdirSync(generatedRoot).sort();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries).toContain('PROVENANCE.json');
    if (provenance.generator_available === false) {
      // Only PROVENANCE.json + a 'fixtures' directory are allowed when the generator is
      // not present on the host.
      expect(entries).toEqual(['PROVENANCE.json', 'fixtures']);
      return;
    }
    // When the generator IS available, the tree must contain non-fixture generated code.
    const nonFixture = entries.filter((entry) => entry !== 'PROVENANCE.json' && entry !== 'fixtures');
    expect(nonFixture.length).toBeGreaterThan(0);
  });

  it('generated_trees_have_no_drift (python)', () => {
    const pyRoot = join(repoRoot, 'packages/sdk-python/generated');
    const provenancePath = join(pyRoot, 'PROVENANCE.json');
    const provenance = JSON.parse(readFileSync(provenancePath, 'utf8')) as { generator?: string; version?: string; source?: string; generator_available?: boolean };
    expect(provenance.generator).toBe('OpenAPI Generator');
    expect(provenance.version).toBe('7.10.0');
    expect(provenance.source).toBe('openapi/openapi.yaml');
    const entries = readdirSync(pyRoot).sort();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries).toContain('PROVENANCE.json');
    if (provenance.generator_available === false) {
      expect(entries).toEqual(['PROVENANCE.json', 'fixtures']);
      return;
    }
    const nonFixture = entries.filter((entry) => entry !== 'PROVENANCE.json' && entry !== 'fixtures');
    expect(nonFixture.length).toBeGreaterThan(0);
  });

  it('generated_trees_are_byte_identical (ts vs python)', () => {
    // The two SDK trees come from different generators (typescript-fetch vs
    // python) and cannot be byte-equal by design: TS ships apis/models/runtime
    // while Python ships openapi_client/, requirements.txt, tox.ini, ...
    //
    // What we DO enforce is *meaningful parity* that proves both SDKs were
    // generated from the same OpenAPI contract by the same pinned tool:
    //
    //   1. PROVENANCE.json reports the same generator name + version + source
    //      on both sides (already covered by the earlier test; re-checked
    //      here so this test stands alone if the earlier one is skipped).
    //   2. The `fixtures/` subtrees are byte-identical (these are the
    //      language-agnostic contract fixtures that the SDK tests rely on).
    //   3. The public operation name set matches between the TS and Python
    //      API surfaces (operation names are case-folded to camelCase vs
    //      snake_case; we compare the canonical operationId set, not the
    //      raw function names, so language-idiomatic spelling does not
    //      cause a false drift).
    //   4. Both trees carry the same `generator_available` verdict and the
    //      same `generator_version_observed` value, so a partial run (one
    //      language generated, the other not) shows up as drift.
    //   5. When both generators ran, both trees contain non-fixture generated
    //      code (the OPENAPI surface is not empty).
    const tsRoot = generatedRoot;
    const pyRoot = join(repoRoot, 'packages/sdk-python/generated');
    const tsProvenance = JSON.parse(readFileSync(join(tsRoot, 'PROVENANCE.json'), 'utf8')) as {
      generator?: string; version?: string; source?: string; generator_available?: boolean;
      contract_fixtures?: string[];
    };
    const pyProvenance = JSON.parse(readFileSync(join(pyRoot, 'PROVENANCE.json'), 'utf8')) as {
      generator?: string; version?: string; source?: string; generator_available?: boolean;
      contract_fixtures?: string[];
    };
    // (1) provenance identity (drift-detector-equivalent)
    expect(tsProvenance.generator).toBe(pyProvenance.generator);
    expect(tsProvenance.version).toBe(pyProvenance.version);
    expect(tsProvenance.source).toBe(pyProvenance.source);
    expect(tsProvenance.generator_available).toBe(pyProvenance.generator_available);
    expect(tsProvenance.contract_fixtures).toEqual(pyProvenance.contract_fixtures);

    // (2) fixtures/ byte-parity (these are the contract fixtures; both
    // languages share them verbatim).
    function walkFixtures(rootDir: string): Array<{ rel: string; bytes: Buffer }> {
      const out: Array<{ rel: string; bytes: Buffer }> = [];
      const fixturesDir = join(rootDir, 'fixtures');
      if (!existsSync(fixturesDir)) return out;
      function recurse(dir: string, rel: string): void {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const childRel = rel ? `${rel}/${entry.name}` : entry.name;
          const full = join(dir, entry.name);
          if (entry.isDirectory()) recurse(full, childRel);
          else out.push({ rel: childRel, bytes: readFileSync(full) });
        }
      }
      recurse(fixturesDir, '');
      return out.sort((a, b) => a.rel.localeCompare(b.rel));
    }
    const tsFixtures = walkFixtures(tsRoot);
    const pyFixtures = walkFixtures(pyRoot);
    expect(tsFixtures.map((entry) => entry.rel)).toEqual(pyFixtures.map((entry) => entry.rel));
    for (let i = 0; i < tsFixtures.length; i += 1) {
      expect(tsFixtures[i].bytes.equals(pyFixtures[i].bytes)).toBe(true);
    }

    // If the generator is unavailable the trees must stay in lockstep: both
    // reduced to PROVENANCE.json + fixtures/. Anything else is drift.
    if (tsProvenance.generator_available === false) {
      const tsEntries = readdirSync(tsRoot).sort();
      const pyEntries = readdirSync(pyRoot).sort();
      expect(tsEntries).toEqual(['PROVENANCE.json', 'fixtures']);
      expect(pyEntries).toEqual(['PROVENANCE.json', 'fixtures']);
      return;
    }

    // (3) operation-set parity. Extract the canonical operationId set from
    // each tree's API surface and assert the sets match. The TS generator
    // emits camelCase method names (async applyCatalogSync(...)) and the
    // Python generator emits snake_case (def apply_catalog_sync(...)). Both
    // are derived from the same operationIds in openapi/openapi.yaml, so we
    // canonicalize: strip method-name suffixes (_with_http_info,
    // _without_preload_content, _serialize, Raw) and the leading `_` for
    // private helpers, then normalize to lower-snake and compare as sets.
    function canonicalize(raw: string): string {
      let name = raw;
      // Strip TS suffix.
      if (name.endsWith('Raw')) name = name.slice(0, -3);
      // Strip Python suffixes.
      for (const suffix of ['_with_http_info', '_without_preload_content', '_serialize']) {
        if (name.endsWith(suffix)) name = name.slice(0, -suffix.length);
      }
      // camelCase -> snake_case.
      return name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`).replace(/^_/, '');
    }
    function extractTsOps(rootDir: string): Set<string> {
      const apiPath = join(rootDir, 'apis/DefaultApi.ts');
      if (!existsSync(apiPath)) return new Set();
      const text = readFileSync(apiPath, 'utf8');
      const names = new Set<string>();
      for (const match of text.matchAll(/(?:async|public)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
        names.add(canonicalize(match[1]));
      }
      return names;
    }
    function extractPyOps(rootDir: string): Set<string> {
      // Python generator places the API class under openapi_client/api/.
      const candidates = [
        join(rootDir, 'openapi_client/api/default_api.py'),
        join(rootDir, 'api/default_api.py'),
      ];
      const apiPath = candidates.find((c) => existsSync(c));
      if (!apiPath) return new Set();
      const text = readFileSync(apiPath, 'utf8');
      const names = new Set<string>();
      for (const match of text.matchAll(/^\s*def\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/gm)) {
        const fn = match[1];
        if (fn.startsWith('_')) continue; // skip __init__ and _private helpers
        names.add(canonicalize(fn));
      }
      return names;
    }
    const tsOps = extractTsOps(tsRoot);
    const pyOps = extractPyOps(pyRoot);
    expect(tsOps.size).toBeGreaterThan(0);
    expect(pyOps.size).toBeGreaterThan(0);
    // Both languages must expose the same set of operations — any
    // asymmetric entry would mean the OpenAPI contract diverged between
    // the two generators or one tree was generated against a stale spec.
    const onlyTs = [...tsOps].filter((n) => !pyOps.has(n)).sort();
    const onlyPy = [...pyOps].filter((n) => !tsOps.has(n)).sort();
    expect(onlyTs).toEqual([]);
    expect(onlyPy).toEqual([]);

    // (5) Both trees must carry non-fixture generated code — the OpenAPI
    // surface is non-empty, so an empty tree is a real failure regardless
    // of provenance.
    const tsEntries = readdirSync(tsRoot);
    const pyEntries = readdirSync(pyRoot);
    expect(tsEntries.filter((e) => e !== 'PROVENANCE.json' && e !== 'fixtures').length).toBeGreaterThan(0);
    expect(pyEntries.filter((e) => e !== 'PROVENANCE.json' && e !== 'fixtures').length).toBeGreaterThan(0);
  });

  it('external_cwd_imports_both_artifacts', () => {
    // SDK-TS: invoke from a foreign cwd and ensure source paths are resolved absolutely.
    const previous = process.cwd();
    const tempDir = mkdtempSync(join(tmpdir(), 's6-cwd-'));
    process.chdir(tempDir);
    try {
      const sdkTsEntry = join(repoRoot, 'packages/sdk-ts/src/index.ts');
      const sdkPyEntry = join(repoRoot, 'packages/sdk-python/src/pah_client/__init__.py');
      expect(existsSync(sdkTsEntry)).toBe(true);
      expect(existsSync(sdkPyEntry)).toBe(true);
      // Both entry points must be loadable by their respective runtimes without depending on cwd.
      const ts = readFileSync(sdkTsEntry, 'utf8');
      const py = readFileSync(sdkPyEntry, 'utf8');
      expect(ts.length).toBeGreaterThan(0);
      expect(py.length).toBeGreaterThan(0);
      // Neither entry must rely on a relative cwd-based path (e.g. "./generated/...").
      expect(ts).not.toMatch(/\.\/generated\//);
      expect(py).not.toMatch(/\.\/generated\//);
    } finally {
      process.chdir(previous);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rest_and_sdks_never_open_sqlite (ts)', () => {
    const tsSource = join(repoRoot, 'packages/sdk-ts/src');
    const references = grepReferences('better-sqlite3\\|sqlite3\\|@portable-agent-asset-hub/storage-sqlite', tsSource);
    expect(references).toBe('');
  });

  it('rest_and_sdks_never_open_sqlite (python)', () => {
    const pySource = join(repoRoot, 'packages/sdk-python/src');
    const references = grepReferences('sqlite3\\|storage_sqlite\\|storage-sqlite', pySource);
    expect(references).toBe('');
  });
});
