// packages/storage-files/src/skill-pack-importer.ts
//
// Phase 2 — Skill pack importer implementation.
//
// All filesystem reads for the skill pack importer live in this
// module. `core` exposes only the contract types, the name
// derivations, the deterministic mime detector and the secret
// scanner. This module is the only one that calls `node:fs`,
// `node:path`, or pulls raw bytes from the inventory's referenced
// sources.
//
// Design contract:
//
//   * `SkillPackImporter.scan(input)` is pure: one call returns a
//     fresh `{ plan, bodies }`. There are no instance caches and no
//     hidden state — calling `scan` twice over the same inputs is
//     guaranteed to produce byte-identical `plan` and `bodies`
//     (sorted by POSIX byte order everywhere, no Map iteration
//     leaking into digests, no timestamps).
//   * The output `plan` has no `generatedAt` (timestamps are an
//     apply concern, never preview). Bodies are kept in a separate
//     map and only attached to the apply step.
//   * The secret scan runs against each scanned source's body and
//     every text resource. Findings are aggregated (deduped) and
//     surfaced through `error.details.findings` so callers never
//     receive the value itself.
//   * I/O errors are translated into `HubError(VALIDATION, …, 400)`.

import {
  createHash,
} from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
} from 'node:fs';
import {
  basename,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';

import {
  canonicalDigest,
  detectMime,
  deriveLogicalKey,
  deriveSkillId,
  GOVERNED_SEGMENTS,
  HubError,
  isTextMime,
  normalizeName,
  SAFE_RESOURCE_PATH,
  scanBuffer,
  sha256Hex,
  SKILL_BASENAME,
  SKILL_INVENTORY_SCHEMA_VERSION,
  SKILL_PACK_PREVIEW_SCHEMA_VERSION,
  validateResourceMime,
  validateResourcePath,
  validateRelationInput,
  type SkillInventoryEntry,
  type SkillInventoryV1,
  type SkillPackCollectedBytes,
  type SkillPackCounts,
  type SkillPackPackagePlan,
  type SkillPackPlan,
  type SkillPackResourcePlan,
  type SkillPackScanResult,
  type SkillPackSource,
  type SkillSecretFinding,
  type SkillRelationInput,
} from '@portable-agent-asset-hub/core';

const SKILL_RELATIONS_MANIFEST = 'skill-relations.json';

// ─── POSIX byte-order comparator ────────────────────────────────────────
//
// The previous implementation used `String.prototype.localeCompare`,
// which is not byte-stable across runtimes (ICU data version,
// collation tweaks) — and this surface is explicitly required to be
// reproducible forever. `comparePosix` returns -1/0/1 by raw UTF-16
// code-unit comparison, which is identical on every Node ≥ 22 runtime
// we ship to. Tests assert the order: README.md (no slash) must come
// before subdirectory paths (slash '/').

export function comparePosix(left: string, right: string): -1 | 0 | 1 {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

// ─── Roots-config + inventory readers ───────────────────────────────────

interface RootConfig {
  id: string;
  path: string;
  excludePrefixes: string[];
}

export function readRootsConfig(path: string): RootConfig[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileUtf8(path)) as unknown;
  } catch (error) {
    throw new HubError('VALIDATION', `roots-config is not valid JSON: ${(error as Error).message}`, 400);
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new HubError('VALIDATION', 'roots-config must be a non-empty array', 400);
  }
  const ids = new Set<string>();
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new HubError('VALIDATION', `roots-config[${index}] must be an object`, 400);
    }
    const obj = entry as Record<string, unknown>;
    const id = obj.id;
    const pathValue = obj.path;
    const excludePrefixes = obj.excludePrefixes;
    if (typeof id !== 'string' || id.length === 0) {
      throw new HubError('VALIDATION', `roots-config[${index}].id is required`, 400);
    }
    if (ids.has(id)) {
      throw new HubError('VALIDATION', `duplicate roots-config id: ${id}`, 400);
    }
    ids.add(id);
    if (typeof pathValue !== 'string' || pathValue.length === 0) {
      throw new HubError('VALIDATION', `roots-config[${index}].path is required`, 400);
    }
    const resolved = resolve(pathValue);
    const canonical = realpathSync(resolved);
    const stat = lstatSync(canonical);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new HubError('VALIDATION', `roots-config[${index}].path is not a regular directory: ${canonical}`, 400);
    }
    const prefixes = Array.isArray(excludePrefixes)
      ? excludePrefixes.map((prefix, prefixIndex) => {
        if (typeof prefix !== 'string') {
          throw new HubError('VALIDATION', `roots-config[${index}].excludePrefixes[${prefixIndex}] must be a string`, 400);
        }
        const normalized = prefix.replaceAll('\\', '/').replace(/^\.\//u, '');
        if (normalized.length === 0 || normalized.startsWith('/') || normalized.split('/').includes('..')) {
          throw new HubError('VALIDATION', `invalid roots-config excludePrefix: ${prefix}`, 400);
        }
        return normalized.replace(/\/$/u, '');
      })
      : [];
    return { id, path: canonical, excludePrefixes: prefixes };
  });
}

export function readInventory(path: string): SkillInventoryV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileUtf8(path)) as unknown;
  } catch (error) {
    throw new HubError('VALIDATION', `inventory is not valid JSON: ${(error as Error).message}`, 400);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new HubError('VALIDATION', 'inventory must be a JSON object', 400);
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.schemaVersion !== SKILL_INVENTORY_SCHEMA_VERSION) {
    throw new HubError('VALIDATION', `unsupported inventory schemaVersion: ${String(obj.schemaVersion)}`, 400);
  }
  const inventoryDigest = obj.inventoryDigest;
  if (typeof inventoryDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(inventoryDigest)) {
    throw new HubError('VALIDATION', 'inventoryDigest must be a 64-character SHA-256 hex digest', 400);
  }
  const stablePayload = { ...obj };
  delete stablePayload.inventoryDigest;
  delete stablePayload.generatedAt;
  const recomputed = canonicalDigest(stablePayload);
  if (recomputed !== inventoryDigest) {
    throw new HubError('VALIDATION', 'inventoryDigest mismatch', 400);
  }
  return obj as unknown as SkillInventoryV1;
}

function readFileUtf8(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new HubError('VALIDATION', `not a file: ${path}`, 400);
    const chunks: Buffer[] = [];
    let remaining = stat.size;
    let offset = 0;
    while (remaining > 0) {
      const chunk = Buffer.alloc(Math.min(65536, remaining));
      const n = readSync(fd, chunk, 0, chunk.length, offset);
      if (n === 0) break;
      chunks.push(chunk.subarray(0, n));
      offset += n;
      remaining -= n;
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function validateExclusion(entry: SkillInventoryEntry): void {
  if (!entry || typeof entry !== 'object') {
    throw new HubError('VALIDATION', 'inventory entry is not an object', 400);
  }
  if (typeof entry.rootId !== 'string' || entry.rootId.length === 0) {
    throw new HubError('VALIDATION', 'inventory entry rootId missing', 400);
  }
  if (typeof entry.relativePath !== 'string' || entry.relativePath.length === 0) {
    throw new HubError('VALIDATION', 'inventory entry relativePath missing', 400);
  }
  if (!entry.relativePath.endsWith('/' + SKILL_BASENAME)) {
    throw new HubError('VALIDATION', `inventory entry must end with /${SKILL_BASENAME}: ${entry.relativePath}`, 400);
  }
  if (typeof entry.sha256 !== 'string' || entry.sha256.length !== 64 || !/^[0-9a-f]+$/u.test(entry.sha256)) {
    throw new HubError('VALIDATION', `inventory entry sha256 malformed: ${entry.relativePath}`, 400);
  }
  if (!Number.isInteger(entry.size) || entry.size < 0 || entry.size > 1024 * 1024) {
    throw new HubError('VALIDATION', `inventory entry size out of range: ${entry.relativePath}`, 400);
  }
}

function safeRelative(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//u, '');
  if (normalized.length === 0 || normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new HubError('VALIDATION', `unsafe relative path: ${value}`, 400);
  }
  if (!SAFE_RESOURCE_PATH.test(normalized)) {
    throw new HubError('VALIDATION', `relative path has forbidden characters: ${value}`, 400);
  }
  return normalized;
}

// ─── Per-source walk (body + resources + nested SKILL.md guard) ─────────

interface CollectedResource {
  relativePath: string;
  mode: 0o644 | 0o755;
  mime: string;
  size: number;
  sha256: string;
  bytes: Buffer;
  isText: boolean;
}

interface PackageSource {
  rootId: string;
  rootPath: string;
  bodyPath: string;
  bodyRelativePath: string;
  packageDir: string;
  bytes: Buffer;
  sha256: string;
  size: number;
  declaredName: string;
  summary?: string;
}

function readOne(absolutePath: string): {
  mode: 0o644 | 0o755;
  size: number;
  sha256: string;
  bytes: Buffer;
} {
  const stat = lstatSync(absolutePath);
  if (stat.isSymbolicLink()) {
    throw new HubError('VALIDATION', `symlink rejected: ${absolutePath}`, 400);
  }
  if (!stat.isFile()) {
    throw new HubError('VALIDATION', `not a regular file: ${absolutePath}`, 400);
  }
  const fd = openSync(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) {
      throw new HubError('VALIDATION', `file identity changed during read: ${absolutePath}`, 400);
    }
    if (opened.size > 4 * 1024 * 1024) {
      throw new HubError('VALIDATION', `resource exceeds 4 MiB: ${absolutePath}`, 400);
    }
    const chunks: Buffer[] = [];
    let remaining = opened.size;
    let offset = 0;
    while (remaining > 0) {
      const chunk = Buffer.alloc(Math.min(65536, remaining));
      const n = readSync(fd, chunk, 0, chunk.length, offset);
      if (n === 0) break;
      chunks.push(chunk.subarray(0, n));
      offset += n;
      remaining -= n;
    }
    const bytes = Buffer.concat(chunks);
    const after = fstatSync(fd);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ino !== opened.ino) {
      throw new HubError('VALIDATION', `file changed during read: ${absolutePath}`, 400);
    }
    const mode = (stat.mode & 0o100) === 0o100 ? (0o755 as const) : (0o644 as const);
    return {
      mode,
      size: bytes.byteLength,
      sha256: sha256Hex(bytes),
      bytes,
    };
  } finally {
    closeSync(fd);
  }
}

function posix(absolute: string, base: string): string {
  return relative(base, absolute).split(sep).join('/');
}

function collectResources(
  packageDir: string,
  rootDir: string,
  excludePrefixes: string[],
): CollectedResource[] {
  const out: CollectedResource[] = [];
  const realRoot = realpathSync(rootDir);
  const realPackageDir = realpathSync(packageDir);

  const walk = (directory: string): void => {
    const before = lstatSync(directory);
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw new HubError('VALIDATION', `package directory is not a regular directory: ${directory}`, 400);
    }
    const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => comparePosix(a.name, b.name));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const childStat = lstatSync(absolute);
      if (childStat.isSymbolicLink()) {
        throw new HubError('VALIDATION', `symlink rejected inside skill package: ${posix(absolute, realPackageDir)}`, 400);
      }
      const relFromRoot = posix(absolute, realRoot);
      const relFromPackage = posix(absolute, realPackageDir);
      if (entry.isDirectory()) {
        if (GOVERNED_SEGMENTS.has(entry.name)) continue;
        if (excludePrefixes.some((prefix) => relFromRoot === prefix || relFromRoot.startsWith(`${prefix}/`))) continue;
        walk(absolute);
        continue;
      }
      if (!entry.isFile()) {
        throw new HubError('VALIDATION', `special file rejected inside skill package: ${relFromPackage}`, 400);
      }
      if (entry.name === SKILL_BASENAME) {
        // The body itself is loaded separately; do not double-count.
        continue;
      }
      if (GOVERNED_SEGMENTS.has(entry.name)) continue;
      if (excludePrefixes.some((prefix) => relFromRoot === prefix || relFromRoot.startsWith(`${prefix}/`))) continue;
      const collected = readOne(absolute);
      const validated = validateResourcePath(relFromPackage);
      const mime = validateResourceMime(detectMime(validated));
      out.push({
        relativePath: validated,
        mode: collected.mode,
        mime,
        size: collected.size,
        sha256: collected.sha256,
        bytes: collected.bytes,
        isText: isTextMime(mime),
      });
    }
    const after = lstatSync(directory);
    if (after.dev !== before.dev || after.ino !== before.ino) {
      throw new HubError('VALIDATION', 'package directory identity changed during read', 400);
    }
  };

  walk(realPackageDir);
  out.sort((a, b) => comparePosix(a.relativePath, b.relativePath));
  return out;
}

function parseFrontmatterName(bytes: Buffer): { name: string; description?: string } {
  const head = bytes.subarray(0, Math.min(bytes.byteLength, 4096)).toString('utf8');
  const openerLen = head.startsWith('---\r\n') ? 5 : head.startsWith('---\n') ? 4 : head === '---' ? 3 : 0;
  if (openerLen === 0) return { name: '' };
  const tail = head.slice(openerLen);
  const closeMarker = tail.indexOf('\n---');
  if (closeMarker === -1) return { name: '' };
  const block = tail.slice(0, closeMarker);
  let name = '';
  let description: string | undefined;
  for (const line of block.split(/\r?\n/u)) {
    const match = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/u.exec(line);
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    let raw = match[2] ?? '';
    if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1);
    else if (raw.startsWith("'") && raw.endsWith("'")) raw = raw.slice(1, -1);
    else raw = raw.split(/\s+#/u)[0] ?? '';
    raw = raw.trim();
    if (raw.length === 0) continue;
    if (key === 'name' && name.length === 0) name = raw;
    else if (key === 'description' && description === undefined) description = raw;
  }
  return { name, description };
}

function loadBody(
  packageDir: string,
  rootDir: string,
  entry: SkillInventoryEntry,
): {
  bytes: Buffer;
  sha256: string;
  size: number;
  declaredName: string;
  summary?: string;
} {
  const realRoot = realpathSync(rootDir);
  const realDir = realpathSync(packageDir);
  if (!realDir.startsWith(realRoot + sep) && realDir !== realRoot) {
    throw new HubError('VALIDATION', `package directory escapes root: ${packageDir}`, 400);
  }
  const skillRelative = posix(realDir, realRoot);
  if (skillRelative.split('/').some((segment) => GOVERNED_SEGMENTS.has(segment))) {
    throw new HubError('VALIDATION', `package directory falls under a governed segment: ${skillRelative}`, 400);
  }
  const bodyPath = join(realDir, SKILL_BASENAME);
  const bodyStat = lstatSync(bodyPath);
  if (bodyStat.isSymbolicLink()) {
    throw new HubError('VALIDATION', `SKILL.md is a symlink: ${entry.relativePath}`, 400);
  }
  if (!bodyStat.isFile()) {
    throw new HubError('VALIDATION', `SKILL.md is not a regular file: ${entry.relativePath}`, 400);
  }
  const fd = openSync(bodyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size !== bodyStat.size || opened.ino !== bodyStat.ino) {
      throw new HubError('VALIDATION', `SKILL.md identity changed during read: ${entry.relativePath}`, 400);
    }
    if (opened.size > 1024 * 1024) {
      throw new HubError('VALIDATION', `SKILL.md exceeds 1 MiB: ${entry.relativePath}`, 400);
    }
    const chunks: Buffer[] = [];
    let remaining = opened.size;
    let offset = 0;
    while (remaining > 0) {
      const chunk = Buffer.alloc(Math.min(65536, remaining));
      const n = readSync(fd, chunk, 0, chunk.length, offset);
      if (n === 0) break;
      chunks.push(chunk.subarray(0, n));
      offset += n;
      remaining -= n;
    }
    bytes = Buffer.concat(chunks);
    const after = fstatSync(fd);
    if (after.size !== opened.size || after.ino !== opened.ino) {
      throw new HubError('VALIDATION', `SKILL.md changed during read: ${entry.relativePath}`, 400);
    }
  } finally {
    closeSync(fd);
  }
  const sha = sha256Hex(bytes);
  if (sha !== entry.sha256) {
    throw new HubError('VALIDATION', `inventory drift: sha mismatch on ${entry.relativePath}`, 400);
  }
  if (bytes.byteLength !== entry.size) {
    throw new HubError('VALIDATION', `inventory drift: size mismatch on ${entry.relativePath}`, 400);
  }
  const stack = [realDir];
  while (stack.length > 0) {
    const directory = stack.pop()!;
    const dirStat = lstatSync(directory);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
      throw new HubError('VALIDATION', `package directory changed: ${directory}`, 400);
    }
    const dirEntries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => comparePosix(a.name, b.name));
    for (const child of dirEntries) {
      const absolute = join(directory, child.name);
      const childLstat = lstatSync(absolute);
      if (childLstat.isSymbolicLink()) {
        throw new HubError('VALIDATION', `nested symlink rejected: ${posix(absolute, realRoot)}`, 400);
      }
      if (childLstat.isDirectory()) {
        if (GOVERNED_SEGMENTS.has(child.name)) continue;
        stack.push(absolute);
        continue;
      }
      if (childLstat.isFile() && child.name === SKILL_BASENAME && absolute !== bodyPath) {
        throw new HubError('VALIDATION', `ambiguous nested ${SKILL_BASENAME}: ${posix(absolute, realRoot)}`, 400);
      }
    }
  }
  const { name, description } = parseFrontmatterName(bytes);
  const declaredName = name.length > 0 ? name : basename(skillRelative) || entry.rootId;
  return {
    bytes,
    sha256: sha,
    size: bytes.byteLength,
    declaredName,
    summary: description,
  };
}

function parseRelationsManifest(resource: CollectedResource | undefined, sourceSkillId: string): SkillRelationInput[] {
  if (!resource) return [];
  if (resource.size > 64 * 1024) throw new HubError('VALIDATION', `${SKILL_RELATIONS_MANIFEST} exceeds 64 KiB`, 400);
  let parsed: unknown;
  try { parsed = JSON.parse(resource.bytes.toString('utf8')); } catch { throw new HubError('VALIDATION', `${SKILL_RELATIONS_MANIFEST} is not valid JSON`, 400); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HubError('VALIDATION', `${SKILL_RELATIONS_MANIFEST} must be an object`, 400);
  const doc = parsed as { schemaVersion?: unknown; sourceSkillId?: unknown; relations?: unknown };
  if (doc.schemaVersion !== 1 || doc.sourceSkillId !== sourceSkillId || !Array.isArray(doc.relations) || doc.relations.length > 128) {
    throw new HubError('VALIDATION', `${SKILL_RELATIONS_MANIFEST} has invalid schema/source/relations`, 400);
  }
  return doc.relations.map((raw) => validateRelationInput(raw as SkillRelationInput, sourceSkillId));
}

// ─── Public scan: pure, no instance state ──────────────────────────────

export interface SkillPackScanInput {
  rootsConfigPath: string;
  inventoryPath: string;
}

export class SkillPackImporter {
  public constructor() {}

  public scan(input: SkillPackScanInput): SkillPackScanResult {
    const roots = readRootsConfig(input.rootsConfigPath);
    const inventory = readInventory(input.inventoryPath);
    const rootsById = new Map(roots.map((root) => [root.id, root]));

    for (const dup of inventory.duplicateNames) {
      if (dup.paths.length > 1) {
        throw new HubError('VALIDATION', `duplicate skill name "${dup.value}" across ${dup.paths.length} sources`, 400);
      }
    }
    if (inventory.logicalKeyCollisions.length > 0) {
      throw new HubError('VALIDATION', `inventory contains ${inventory.logicalKeyCollisions.length} logical key collisions`, 400);
    }

    interface PackageBuilder {
      name: string;
      summary?: string;
      sources: PackageSource[];
      resourcesBySource: Map<string, CollectedResource[]>;
    }
    const packageBuilders = new Map<string, PackageBuilder>();

    for (const entry of inventory.entries) {
      validateExclusion(entry);
      const root = rootsById.get(entry.rootId);
      if (!root) {
        throw new HubError('VALIDATION', `inventory references unknown root: ${entry.rootId}`, 400);
      }
      const bodyRelative = safeRelative(entry.relativePath);
      if (!bodyRelative.endsWith('/' + SKILL_BASENAME)) {
        throw new HubError('VALIDATION', `inventory entry must end with /${SKILL_BASENAME}`, 400);
      }
      const packageRelDir = bodyRelative.slice(0, -('/' + SKILL_BASENAME).length);
      if (packageRelDir.length === 0) {
        throw new HubError('VALIDATION', `inventory entry has no parent directory: ${bodyRelative}`, 400);
      }
      const packageDir = join(root.path, packageRelDir);
      const loaded = loadBody(packageDir, root.path, entry);
      const collected = collectResources(packageDir, root.path, root.excludePrefixes);
      const source: PackageSource = {
        rootId: entry.rootId,
        rootPath: root.path,
        bodyPath: join(packageDir, SKILL_BASENAME),
        bodyRelativePath: bodyRelative,
        packageDir,
        bytes: loaded.bytes,
        sha256: loaded.sha256,
        size: loaded.size,
        declaredName: loaded.declaredName,
        summary: loaded.summary,
      };

      const normalizedName = normalizeName(source.declaredName);
      if (normalizeName(entry.name) !== normalizedName) {
        throw new HubError('VALIDATION', `inventory drift: declared name mismatch on ${entry.relativePath}`, 400);
      }
      const logicalKey = deriveLogicalKey(source.declaredName);
      const existing = packageBuilders.get(logicalKey);
      if (existing) {
        if (existing.name !== normalizedName) {
          throw new HubError('VALIDATION', `normalized name mismatch for ${logicalKey}`, 400);
        }
        if (existing.sources[0]?.sha256 !== source.sha256) {
          throw new HubError('VALIDATION', `conflicting bodies for ${logicalKey}`, 400);
        }
        existing.sources.push(source);
        existing.resourcesBySource.set(entry.rootId, collected);
      } else {
        packageBuilders.set(logicalKey, {
          name: normalizedName,
          summary: source.summary,
          sources: [source],
          resourcesBySource: new Map([[entry.rootId, collected]]),
        });
      }
    }

    const allFindings: SkillSecretFinding[] = [];
    const packages: SkillPackPackagePlan[] = [];
    const bodies = new Map<string, SkillPackCollectedBytes>();

    for (const [logicalKey, builder] of packageBuilders) {
      void logicalKey;
      const id = deriveSkillId(builder.name);
      const aggregated: CollectedResource[] = [];
      const seen = new Set<string>();
      for (const source of builder.sources) {
        const collected = builder.resourcesBySource.get(source.rootId) ?? [];
        for (const resource of collected) {
          if (seen.has(resource.relativePath)) {
            throw new HubError('VALIDATION', `resource path "${resource.relativePath}" is shared across roots`, 400);
          }
          seen.add(resource.relativePath);
          aggregated.push(resource);
        }
      }
      aggregated.sort((a, b) => comparePosix(a.relativePath, b.relativePath));
      const relationManifest = aggregated.find((resource) => resource.relativePath === SKILL_RELATIONS_MANIFEST);
      const relations = parseRelationsManifest(relationManifest, id);
      const payloadResources = aggregated.filter((resource) => resource.relativePath !== SKILL_RELATIONS_MANIFEST);
      const packageBytes = builder.sources[0]!.size
        + aggregated.reduce((sum, resource) => sum + resource.size, 0);
      if (packageBytes > 16 * 1024 * 1024) {
        throw new HubError('VALIDATION', `skill package exceeds 16 MiB: ${builder.name}`, 400);
      }

      for (const source of builder.sources) {
        for (const finding of scanBuffer(source.bytes, {
          rootId: source.rootId,
          relativePath: source.bodyRelativePath,
          isText: true,
        })) {
          allFindings.push(finding);
        }
      }
      for (const resource of aggregated) {
        if (!resource.isText) continue;
        for (const source of builder.sources) {
          const matched = builder.resourcesBySource.get(source.rootId)?.find((entry) => entry.relativePath === resource.relativePath);
          if (!matched) continue;
          for (const finding of scanBuffer(matched.bytes, {
            rootId: source.rootId,
            relativePath: resource.relativePath,
            isText: true,
          })) {
            allFindings.push(finding);
          }
        }
      }

      const packagePlan: SkillPackPackagePlan = {
        id,
        name: builder.name,
        ...(builder.summary !== undefined ? { summary: builder.summary } : {}),
        logicalKey,
        bodySha256: builder.sources[0]!.sha256,
        bodySize: builder.sources[0]!.size,
        resources: payloadResources.map<SkillPackResourcePlan>((resource) => ({
          relativePath: resource.relativePath,
          mode: resource.mode,
          mime: resource.mime,
          size: resource.size,
          sha256: resource.sha256,
        })),
        sources: builder.sources.map<SkillPackSource>((source) => ({
          rootId: source.rootId,
          relativePath: source.bodyRelativePath,
          bodySha256: source.sha256,
          size: source.size,
        })),
        ...(relationManifest ? { relations, relationsDeclared: true } : {}),
      };
      packages.push(packagePlan);

      const collectedForBody: SkillPackCollectedBytes = {
        body: builder.sources[0]!.bytes,
        resources: payloadResources
          .map((resource) => ({
            relativePath: resource.relativePath,
            mode: resource.mode,
            mime: resource.mime,
            bytes: resource.bytes,
          }))
          .sort((a, b) => comparePosix(a.relativePath, b.relativePath)),
      };
      bodies.set(id, collectedForBody);
    }

    packages.sort((a, b) => comparePosix(a.logicalKey, b.logicalKey));

    const counts: SkillPackCounts = {
      packages: packages.length,
      resources: packages.reduce((sum, pkg) => sum + pkg.resources.length, 0),
      totalBytes: packages.reduce((sum, pkg) => sum + pkg.bodySize + pkg.resources.reduce((s: number, r) => s + r.size, 0), 0),
      sources: packages.reduce((sum, pkg) => sum + pkg.sources.length, 0),
      secretFindings: allFindings.length,
    };

    if (allFindings.length > 0) {
      throw new HubError(
        'VALIDATION',
        `preview blocked by ${allFindings.length} secret findings`,
        400,
        { findings: allFindings },
      );
    }

    const plan: SkillPackPlan = {
      schemaVersion: SKILL_PACK_PREVIEW_SCHEMA_VERSION,
      inventoryDigest: inventory.inventoryDigest,
      planDigest: '',
      scope: inventory.scope,
      profile: inventory.profile,
      roots: roots.map((root) => ({ id: root.id, excludePrefixes: [...root.excludePrefixes] })),
      packages,
      counts,
      secretFindings: allFindings,
    };
    plan.planDigest = canonicalDigest(plan);

    return { plan, bodies };
  }
}

// `createHash` is re-exported so callers (notably tests that want to
// re-hash a local resource) can do so without touching `node:crypto`.
export { createHash };
