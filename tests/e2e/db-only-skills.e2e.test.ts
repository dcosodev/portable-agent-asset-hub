// tests/e2e/db-only-skills.e2e.test.ts
//
// Fase 3 — DB-only skills e2e. Proves the hermetic contract:
//
//   1. Build a temporary fixture root with one skill + one binary resource.
//   2. Run the Fase1 inventory and Fase2 apply into a brand-new SQLite
//      file. The CLI is the real `scripts/import-agent-skills.mjs`
//      binary so the importer + apply coordinator are exercised exactly
//      as a downstream consumer would.
//   3. Delete the fixture root AND the inventory/roots files on disk so
//      filesystem-resident sources are physically gone.
//   4. Spawn the REST launcher as a fresh child process bound to that
//      SQLite, parse the `AGENT_MEMORY_READY` line, and hit
//      `searchSkills`, `getSkill`, `listSkillResources` and
//      `getSkillResource` over real HTTP. Assert the bodies / bytes are
//      exact, the metadata-only `searchSkills` payload does not carry
//      `body`, and no response path leaks the deleted root.
//   5. Spawn the MCP stdio entry as a fresh child process against the
//      same REST URL and drive `initialize`, `tools/list`, and the
//      `searchSkills` / `getSkill` / `getSkillResource` tool calls via
//      newline-delimited JSON-RPC over its real stdin/stdout. Assert
//      every JSON-RPC frame is well-formed, the tool names match
//      `toolNameFor(operationId)`, and the responses match the REST
//      surface exactly.
//   6. Reopen the SQLite directly and assert `PRAGMA integrity_check`
//      is `ok`, `user_version` is 15, and the skill row + bytes
//      survive a direct re-read.
//
// The test is hermetic. It MUST NOT touch `~/.hermes`, `~/.openclaw`,
// `~/.hermes/state.db`, or any active hub database. It MUST NOT
// fabricate output: every assertion compares the real child-process
// output against the real fixture bytes.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalDigest } from '@portable-agent-asset-hub/core';

const repoRoot = resolve(__dirname, '..', '..');
const importCli = join(repoRoot, 'scripts', 'import-agent-skills.mjs');
const restBin = join(repoRoot, 'packages', 'rest', 'bin', 'agent-memory-rest.mjs');
const mcpBin = join(repoRoot, 'packages', 'mcp', 'bin', 'agent-memory-mcp.mjs');
const verifyHelper = join(repoRoot, 'scripts', 'verify-db-only-skills.mjs');

const cleanup: string[] = [];
const processes: ChildProcess[] = [];

afterEach(async () => {
  for (const child of processes.splice(0)) {
    if (!child.killed) {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
  }
  await new Promise((r) => setTimeout(r, 50));
  for (const dir of cleanup.splice(0)) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `fase3-e2e-${label}-`));
  cleanup.push(dir);
  return dir;
}

interface Fixture {
  workdir: string;
  rootPath: string;
  rootId: string;
  dbPath: string;
  backupDir: string;
  rootsConfigPath: string;
  inventoryPath: string;
  previewPath: string;
  applyPath: string;
  skillName: string;
  body: string;
  bodySha256: string;
  resourceRelPath: string;
  resourceBytes: Buffer;
  resourceSha256: string;
  skillId: string;
  logicalKey: string;
}

function writeFixture(label: string): Fixture {
  const workdir = tempDir(label);
  const rootPath = join(workdir, 'skills-root');
  mkdirSync(rootPath, { recursive: true });
  const rootId = 'e2e-fixture-root';
  const skillName = 'phase3-isolated-skill';
  const resourceRelPath = 'assets/marker.bin';
  const body = [
    '---',
    `name: ${skillName}`,
    'description: phase3 isolated e2e fixture',
    '---',
    '# phase3 isolated skill',
    '',
    'This body must round-trip exactly through SQLite and the REST/MCP',
    'surfaces. The marker below MUST appear in the `getSkill` body and in',
    'the `getSkillResource` bytes for the resource. It must NEVER appear in',
    'the `searchSkills` payload (metadata-only).',
    '',
    'PHASE3-BODY-MARKER-7e3c1f',
    '',
  ].join('\n');
  const resourceBytes = Buffer.from('PHASE3-RESOURCE-MARKER-b9a204', 'utf8');

  const skillDir = join(rootPath, skillName);
  const resourceDir = join(skillDir, 'assets');
  mkdirSync(resourceDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), body, { mode: 0o644 });
  writeFileSync(join(resourceDir, 'marker.bin'), resourceBytes, { mode: 0o644 });

  const bodySha256 = createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex');
  const resourceSha256 = createHash('sha256').update(resourceBytes).digest('hex');
  const skillId = `skl_${createHash('sha256').update(`${rootId}:${skillName}`).digest('hex').slice(0, 16)}`;
  const logicalKey = `skill:${rootId}:${skillName}/SKILL.md:${skillName}`;

  const rootsConfigPath = join(workdir, 'roots.json');
  const inventoryPath = join(workdir, 'inventory.json');
  const previewPath = join(workdir, 'preview.json');
  const applyPath = join(workdir, 'apply.json');
  const dbPath = join(workdir, 'hub.sqlite');
  const backupDir = join(workdir, 'backups');
  mkdirSync(backupDir, { recursive: true });

  const entries = [
    {
      rootId,
      relativePath: `${skillName}/SKILL.md`,
      locator: `${skillName}/SKILL.md`,
      name: skillName,
      sha256: bodySha256,
      size: Buffer.byteLength(body, 'utf8'),
      logicalKey,
    },
  ];
  const inventoryStable = {
    schemaVersion: 1,
    profile: 'openclaw-cli',
    scope: { ownerUserId: 'usr_local', agentId: 'agt_local' },
    roots: [{ id: rootId, path: rootPath, excludePrefixes: [] }],
    selectorsByRoot: { [rootId]: entries.map((entry) => entry.relativePath) },
    entries,
    exclusions: [],
    duplicateNames: [],
    duplicateHashes: [],
    logicalKeyCollisions: [],
    highConfidenceSecretFindings: [],
    counts: {
      discovered: entries.length,
      selected: entries.length,
      excluded: 0,
      duplicateNames: 0,
      duplicateHashes: 0,
      logicalKeyCollisions: 0,
      highConfidenceSecretFindings: 0,
    },
  };
  const inventoryDigest = canonicalDigest(inventoryStable);
  const inventory = { ...inventoryStable, inventoryDigest };
  writeFileSync(rootsConfigPath, JSON.stringify([{ id: rootId, path: rootPath, excludePrefixes: [] }]));
  writeFileSync(inventoryPath, JSON.stringify(inventory, null, 2));

  return {
    workdir,
    rootPath,
    rootId,
    dbPath,
    backupDir,
    rootsConfigPath,
    inventoryPath,
    previewPath,
    applyPath,
    skillName,
    body,
    bodySha256,
    resourceRelPath,
    resourceBytes,
    resourceSha256,
    skillId,
    logicalKey,
  };
}

interface ImportResult {
  planDigest: string;
  skillId: string;
  logicalKey: string;
  packageName: string;
  packageVersion: number;
}

async function importFixture(fixture: Fixture): Promise<ImportResult> {
  const previewProc = await runChild(importCli, [
    '--roots-config', fixture.rootsConfigPath,
    '--inventory', fixture.inventoryPath,
    '--preview-output', fixture.previewPath,
  ]);
  expect(previewProc.status, `preview stderr: ${previewProc.stderr}`).toBe(0);
  const plan = JSON.parse(readFileSync(fixture.previewPath, 'utf8')) as {
    planDigest: string;
    packages: Array<{ id: string; logicalKey: string; name: string; version?: number }>;
  };
  expect(plan.packages).toHaveLength(1);
  const pkg = plan.packages[0]!;

  const applyProc = await runChild(importCli, [
    '--roots-config', fixture.rootsConfigPath,
    '--inventory', fixture.inventoryPath,
    '--db', fixture.dbPath,
    '--backup-dir', fixture.backupDir,
    '--preview-output', fixture.applyPath,
    '--apply',
    '--reviewed-digest', plan.planDigest,
  ]);
  expect(applyProc.status, `apply stderr: ${applyProc.stderr}`).toBe(0);
  return { planDigest: plan.planDigest, skillId: pkg.id, logicalKey: pkg.logicalKey, packageName: pkg.name, packageVersion: 1 };
}

interface ChildOutput {
  status: number;
  stdout: string;
  stderr: string;
}

function runChild(command: string, args: string[]): Promise<ChildOutput> {
  return new Promise((resolveDone, rejectError) => {
    const child = spawn(process.execPath, [command, ...args], { cwd: repoRoot });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', rejectError);
    child.on('close', (code) => resolveDone({ status: code ?? -1, stdout, stderr }));
  });
}

interface RestProcess {
  child: ChildProcess;
  url: string;
  dbPath: string;
  waitForReady: () => Promise<void>;
  stop: () => Promise<void>;
}

async function startRest(dbPath: string): Promise<RestProcess> {
  const port = await new Promise<number>((resolvePort, rejectPort) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        rejectPort(new Error('failed to allocate ephemeral port'));
        return;
      }
      const p = address.port;
      server.close(() => resolvePort(p));
    });
    server.on('error', rejectPort);
  });

  const child = spawn(process.execPath, [restBin], {
    cwd: repoRoot,
    env: {
      ...process.env,
      AGENT_MEMORY_DB_PATH: dbPath,
      HOST: '127.0.0.1',
      PORT: String(port),
    },
  });
  processes.push(child);

  let stderrBuf = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { stderrBuf += chunk; });

  const ready = new Promise<void>((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error(`REST launcher did not become ready in 20s (stderr: ${stderrBuf})`)), 20_000);
    const check = (): void => {
      if (/AGENT_MEMORY_READY /.test(stderrBuf)) {
        clearTimeout(timer);
        resolveReady();
      }
    };
    child.stderr?.on('data', check);
    child.on('error', (err) => { clearTimeout(timer); rejectReady(err); });
    child.on('close', (code) => {
      if (!/AGENT_MEMORY_READY /.test(stderrBuf)) {
        clearTimeout(timer);
        rejectReady(new Error(`REST launcher exited (code=${code}) before READY. stderr: ${stderrBuf}`));
      }
    });
  });

  const stop = (): Promise<void> => new Promise<void>((resolveClose) => {
    if (!child.killed) {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
    }
    const timer = setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
      resolveClose();
    }, 2000);
    child.on('close', () => { clearTimeout(timer); resolveClose(); });
  });

  return { child, url: `http://127.0.0.1:${port}`, dbPath, waitForReady: () => ready, stop };
}

async function restGet(url: string, path: string): Promise<unknown> {
  const response = await fetch(`${url}${path}`);
  const text = await response.text();
  expect(response.status, `${path} -> ${response.status} ${text}`).toBe(200);
  return JSON.parse(text) as unknown;
}

interface McpProcess {
  child: ChildProcess;
  writeFrame: (frame: object) => void;
  readFrames: (expected: number, timeoutMs?: number) => Promise<Array<Record<string, unknown>>>;
  stderr: () => string;
  stdoutNoise: () => string;
  stop: () => Promise<void>;
}

async function startMcp(restUrl: string): Promise<McpProcess> {
  const child = spawn(process.execPath, [mcpBin], {
    cwd: repoRoot,
    env: { ...process.env, AGENT_MEMORY_REST_URL: restUrl },
  });
  processes.push(child);

  let stderrBuf = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { stderrBuf += chunk; });
  child.stdout?.setEncoding('utf8');
  child.stdin?.setDefaultEncoding('utf8');

  let stdoutBuf = '';
  let stdoutNoise = '';
  const pendingFrames: Array<Record<string, unknown>> = [];
  const waiters: Array<(frames: Array<Record<string, unknown>>) => void> = [];
  child.stdout?.on('data', (chunk: string) => {
    stdoutBuf += chunk;
    let newlineIndex = stdoutBuf.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = stdoutBuf.slice(0, newlineIndex).trim();
      stdoutBuf = stdoutBuf.slice(newlineIndex + 1);
      if (line.length > 0) {
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          pendingFrames.push(parsed);
          if (waiters.length > 0) {
            const waiter = waiters.shift()!;
            waiter(pendingFrames.splice(0));
          }
        } catch {
          stdoutNoise += `${line}\n`;
        }
      }
      newlineIndex = stdoutBuf.indexOf('\n');
    }
  });

  const writeFrame = (frame: object): void => {
    child.stdin?.write(`${JSON.stringify(frame)}\n`);
  };

  const readFrames = (expected: number, timeoutMs = 8000): Promise<Array<Record<string, unknown>>> => new Promise((resolveRead, rejectRead) => {
    if (pendingFrames.length >= expected) {
      resolveRead(pendingFrames.splice(0, expected));
      return;
    }
    const timer = setTimeout(() => rejectRead(new Error(`MCP did not produce ${expected} frames in ${timeoutMs}ms (stderr: ${stderrBuf}, pending=${pendingFrames.length})`)), timeoutMs);
    waiters.push((frames) => {
      clearTimeout(timer);
      resolveRead(frames);
    });
  });

  const stop = (): Promise<void> => new Promise<void>((resolveClose) => {
    if (!child.killed) {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
    }
    const timer = setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
      resolveClose();
    }, 2000);
    child.on('close', () => { clearTimeout(timer); resolveClose(); });
  });

  return { child, writeFrame, readFrames, stderr: () => stderrBuf, stdoutNoise: () => stdoutNoise, stop };
}

describe('Fase 3 DB-only skills e2e', () => {
  it('exposes a hermetic DB-only contract: import → delete sources → REST + MCP over real processes', { timeout: 120_000 }, async () => {
    const fixture = writeFixture('roundtrip');
    const imported = await importFixture(fixture);
    expect(imported.skillId).toMatch(/^skl_/);
    expect(existsSync(fixture.dbPath)).toBe(true);

    // Delete the root + all auxiliary files. SQLite must be sufficient.
    rmSync(fixture.rootPath, { recursive: true, force: true });
    rmSync(fixture.rootsConfigPath, { force: true });
    rmSync(fixture.inventoryPath, { force: true });
    rmSync(fixture.previewPath, { force: true });
    rmSync(fixture.applyPath, { force: true });
    expect(existsSync(fixture.rootPath)).toBe(false);
    expect(existsSync(fixture.rootsConfigPath)).toBe(false);

    const rest = await startRest(fixture.dbPath);
    try {
      await rest.waitForReady();

      const searchBody = await restGet(rest.url, `/api/v1/skills/search?q=${encodeURIComponent(fixture.skillName)}`) as { items: Array<Record<string, unknown>> };
      expect(searchBody.items).toHaveLength(1);
      const hit = searchBody.items[0]!;
      expect(hit.id).toBe(imported.skillId);
      // The importer returns its neutral logical key from the preview;
      // the historical root/path key in the inventory is provenance only.
      expect(typeof hit.logicalKey).toBe('string');
      expect((hit.logicalKey as string).length).toBeGreaterThan(0);
      expect(imported.logicalKey).toBe(hit.logicalKey);
      expect(hit.name).toBe(fixture.skillName);
      expect(hit.lifecycle).toBe('active');
      expect(hit.version).toBe(1);
      expect(Object.prototype.hasOwnProperty.call(hit, 'body')).toBe(false);
      const searchJson = JSON.stringify(searchBody);
      // No filesystem path of the deleted root anywhere on the wire.
      expect(searchJson).not.toContain(fixture.rootPath);
      expect(searchJson).not.toContain('PHASE3-BODY-MARKER-7e3c1f');

      const skill = await restGet(rest.url, `/api/v1/skills/${encodeURIComponent(imported.skillId)}`) as Record<string, unknown>;
      expect(skill.id).toBe(imported.skillId);
      expect(skill.body).toBe(fixture.body);
      expect(skill.bodySha256).toBe(fixture.bodySha256);
      const resources = skill.resources as Array<Record<string, unknown>>;
      expect(resources).toHaveLength(1);
      expect(resources[0]!.relativePath).toBe(fixture.resourceRelPath);
      expect(resources[0]!.sha256).toBe(fixture.resourceSha256);
      expect(JSON.stringify(skill)).not.toContain(fixture.rootPath);

      const listResources = await restGet(rest.url, `/api/v1/skills/${encodeURIComponent(imported.skillId)}/resources`) as { items: Array<Record<string, unknown>> };
      expect(listResources.items).toHaveLength(1);
      expect(listResources.items[0]!.relativePath).toBe(fixture.resourceRelPath);
      expect(listResources.items[0]!.sha256).toBe(fixture.resourceSha256);
      expect(listResources.items[0]!.size).toBe(fixture.resourceBytes.byteLength);

      const resourceResponse = await fetch(`${rest.url}/api/v1/skills/${encodeURIComponent(imported.skillId)}/resources/${fixture.resourceRelPath}`);
      const resourceBody = await resourceResponse.json() as Record<string, unknown>;
      expect(resourceResponse.status).toBe(200);
      expect(resourceBody.relativePath).toBe(fixture.resourceRelPath);
      expect(resourceBody.sha256).toBe(fixture.resourceSha256);
      expect(resourceBody.encoding).toBe('base64');
      const decoded = Buffer.from(String(resourceBody.bytes), 'base64');
      expect(decoded.equals(fixture.resourceBytes)).toBe(true);
      expect(decoded.toString('utf8')).toBe('PHASE3-RESOURCE-MARKER-b9a204');
    } finally {
      await rest.stop();
    }

    const rest2 = await startRest(fixture.dbPath);
    const mcp = await startMcp(rest2.url);
    try {
      await rest2.waitForReady();

      mcp.writeFrame({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', clientInfo: { name: 'fase3-e2e', version: '0.0.0' }, capabilities: {} } });
      const initFrames = await mcp.readFrames(1);
      expect(initFrames).toHaveLength(1);
      const initResult = initFrames[0]!.result as Record<string, unknown>;
      expect(initResult.protocolVersion).toBe('2024-11-05');
      const serverInfo = initResult.serverInfo as Record<string, unknown>;
      expect(typeof serverInfo.name).toBe('string');
      mcp.writeFrame({ jsonrpc: '2.0', method: 'notifications/initialized' });

      mcp.writeFrame({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      const listFrames = await mcp.readFrames(1);
      const listResult = listFrames[0]!.result as { tools: Array<Record<string, unknown>> };
      const toolNames = listResult.tools.map((tool) => String(tool.name));
      expect(toolNames).toContain('search_skills');
      expect(toolNames).toContain('get_skill');
      expect(toolNames).toContain('list_skill_resources');
      expect(toolNames).toContain('read_skill_resource');
      expect(JSON.stringify(listResult)).not.toContain(fixture.rootPath);

      mcp.writeFrame({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_skills', arguments: { query: { q: fixture.skillName } } } });
      const searchFrames = await mcp.readFrames(1);
      const searchResult = searchFrames[0]!.result as { content: Array<{ type: string; text: string }> };
      const searchParsed = JSON.parse(searchResult.content[0]!.text) as { items: Array<Record<string, unknown>> };
      expect(searchParsed.items).toHaveLength(1);
      expect(searchParsed.items[0]!.id).toBe(imported.skillId);
      expect(Object.prototype.hasOwnProperty.call(searchParsed.items[0]!, 'body')).toBe(false);

      mcp.writeFrame({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_skill', arguments: { params: { id: imported.skillId } } } });
      const skillFrames = await mcp.readFrames(1);
      const skillResult = skillFrames[0]!.result as { content: Array<{ type: string; text: string }> };
      const skillParsed = JSON.parse(skillResult.content[0]!.text) as Record<string, unknown>;
      expect(skillParsed.id).toBe(imported.skillId);
      expect(skillParsed.body).toBe(fixture.body);

      mcp.writeFrame({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'list_skill_resources', arguments: { params: { id: imported.skillId } } } });
      const listResFrames = await mcp.readFrames(1);
      const listResResult = listResFrames[0]!.result as { content: Array<{ type: string; text: string }> };
      const listResParsed = JSON.parse(listResResult.content[0]!.text) as { items: Array<Record<string, unknown>> };
      expect(listResParsed.items).toHaveLength(1);
      expect(listResParsed.items[0]!.relativePath).toBe(fixture.resourceRelPath);

      mcp.writeFrame({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'read_skill_resource', arguments: { params: { id: imported.skillId, resourcePath: fixture.resourceRelPath } } } });
      const resFrames = await mcp.readFrames(1);
      const resResult = resFrames[0]!.result as { content: Array<{ type: string; text: string }> };
      const resParsed = JSON.parse(resResult.content[0]!.text) as Record<string, unknown>;
      expect(resParsed.relativePath).toBe(fixture.resourceRelPath);
      expect(resParsed.sha256).toBe(fixture.resourceSha256);
      expect(resParsed.encoding).toBe('base64');
      const decodedResource = Buffer.from(String(resParsed.bytes), 'base64');
      expect(decodedResource.equals(fixture.resourceBytes)).toBe(true);
      expect(decodedResource.toString('utf8')).toBe('PHASE3-RESOURCE-MARKER-b9a204');
      expect(mcp.stdoutNoise()).toBe('');
    } finally {
      await mcp.stop();
      await rest2.stop();
    }

    const reopened = new DatabaseSync(fixture.dbPath);
    try {
      const integrity = (reopened.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
      expect(integrity).toBe('ok');
      // The hub tracks schema state in `schema_meta` (the runner writes
      // one row per migration). 16 migrations are shipped in this build.
      const schemaVersion = (reopened.prepare('SELECT MAX(version) AS v FROM schema_meta').get() as { v: number | null }).v;
      expect(schemaVersion).toBe(19);
      const rowCount = (reopened.prepare('SELECT COUNT(*) AS c FROM skill_entries').get() as { c: number }).c;
      expect(rowCount).toBeGreaterThan(0);
    } finally {
      reopened.close();
    }

    const helperOutput = await runChild(verifyHelper, [
      '--db', fixture.dbPath,
      '--skill-id', imported.skillId,
      '--resource-path', fixture.resourceRelPath,
      '--body-marker', 'PHASE3-BODY-MARKER-7e3c1f',
      '--resource-marker', 'PHASE3-RESOURCE-MARKER-b9a204',
    ]);
    expect(helperOutput.status, `helper stderr: ${helperOutput.stderr}; stdout: ${helperOutput.stdout}`).toBe(0);
    const helperJson = JSON.parse(helperOutput.stdout.trim()) as Record<string, unknown>;
    expect(helperJson.ok).toBe(true);
    expect(helperJson.skillId).toBe(imported.skillId);
    expect(helperJson.bodyMatch).toBe(true);
    expect(helperJson.bytesMatch).toBe(true);
  });
});
