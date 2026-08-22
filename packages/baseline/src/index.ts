import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import Ajv2020Module, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

const Ajv2020 = Ajv2020Module as unknown as new (options?: object) => { compile(schema: unknown): ValidateFunction };
const addFormats = addFormatsModule as unknown as (ajv: object) => void;
export type BaselineFile = { path: string; bytes: number; mode: number; sha256: string };
export type BaselineManifest = {
  version: 1; root: string; files: BaselineFile[]; allowlist: string[]; exclusions: string[];
  toolVersion: string; snapshot?: { path: string; sha256: string };
  completeness: 'complete'; extrasPolicy: 'reject-non-excluded'; symlinkPolicy: 'reject-root-and-internal';
};
export type ManifestCheck = { valid: boolean; errors: string[] };

const TOOL_VERSION = 's0-baseline-tool/2.0.0';
export const DEFAULT_EXCLUSIONS = ['.git', '.env', '.env.*', '.venv', 'node_modules', '.pytest_cache', '.ruff_cache', '__pycache__', '*.pyc', 'dist', 'build', '*.egg-info', 'coverage', 'coverage.*', 'caches', 'logs', 'logs/*.log', '*secret*', '*token*', '*cookie*'] as const;

function normalize(value: string): string {
  if (typeof value !== 'string') throw new Error('path must be a string');
  if (value.includes('\0')) throw new Error('NUL in path');
  if (value.includes('\\')) throw new Error(`backslash path is ambiguous: ${value}`);
  if (isAbsolute(value)) throw new Error(`absolute path is not allowed: ${value}`);
  if (value === '.') return value;
  if (value.startsWith('./')) throw new Error(`prefixed path is not canonical: ${value}`);
  if (value.endsWith('/')) throw new Error(`trailing separator is not canonical: ${value}`);
  if (value.includes('//')) throw new Error(`repeated separator is not canonical: ${value}`);
  const segments = value.split('/');
  if (segments.some(segment => segment === '..')) throw new Error(`dotdot path is not allowed: ${value}`);
  if (segments.some(segment => segment === '.')) throw new Error(`dot segment is not allowed: ${value}`);
  if (segments.some(segment => segment.length === 0)) throw new Error(`empty path segment is not allowed: ${value}`);
  const canonical = segments.join('/');
  if (canonical !== value) throw new Error(`path is not canonical: ${value}`);
  return canonical;
}
function validateAllowlist(allowlist: string[]): string[] {
  if (!Array.isArray(allowlist) || allowlist.length === 0) throw new Error('allowlist must be non-empty');
  const normalized = allowlist.map(value => normalize(value));
  if (new Set(normalized).size !== normalized.length) throw new Error('allowlist contains duplicates');
  const sorted = [...normalized].sort();
  if (JSON.stringify(allowlist) !== JSON.stringify(sorted)) throw new Error('allowlist must be sorted and canonical');
  return normalized;
}
function allowed(path: string, allowlist: string[]): boolean {
  return allowlist.some(entry => entry === '.' || path === entry || path.startsWith(`${entry}/`)) && !isExcludedByPolicy(path, DEFAULT_EXCLUSIONS);
}
function globSegment(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i').test(value);
}
export function isExcludedByPolicy(path: string, exclusions: readonly string[] = DEFAULT_EXCLUSIONS): boolean {
  const parts = path.split('/');
  return exclusions.some(pattern => {
    const normalized = pattern.replace(/\/$/, '');
    if (normalized.includes('/')) {
      const expression = normalized.split('/').map(part => part.includes('*') ? `(?:${part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')})` : part.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('/');
      return new RegExp(`(?:^|/)${expression}(?:/|$)`, 'i').test(path);
    }
    return parts.some(part => globSegment(part, normalized));
  });
}
export type BaselineArchiveEntry = { path: string; type: 'file' | 'directory' | 'symlink' | 'hardlink' };
export function validateBaselineArchiveEntries(entries: BaselineArchiveEntry[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const raw = entry.path;
    const path = entry.type === 'directory' && raw.endsWith('/') ? raw.slice(0, -1) : raw;
    if (!path || !path.startsWith('agent-memory/') || path.startsWith('agent-memory/agent-memory/')) errors.push(`archive prefix invalid: ${raw}`);
    if (raw.includes('\0') || raw.includes('\\') || raw.startsWith('/') || path.includes('//') || (entry.type !== 'directory' && raw.endsWith('/')) || path.split('/').some(part => part === '..' || part === '.' || part.length === 0)) errors.push(`archive path invalid: ${raw}`);
    if (entry.type === 'symlink' || entry.type === 'hardlink') errors.push(`archive link rejected: ${raw}`);
    const relativePath = path.startsWith('agent-memory/') ? path.slice('agent-memory/'.length) : path;
    if (relativePath && isExcludedByPolicy(relativePath, DEFAULT_EXCLUSIONS)) errors.push(`archive excluded entry: ${raw}`);
    if (seen.has(path)) errors.push(`archive duplicate entry: ${raw}`);
    seen.add(path);
  }
  return errors;
}
function validateExclusions(exclusions: unknown): string[] {
  if (!Array.isArray(exclusions) || exclusions.some(value => typeof value !== 'string') || JSON.stringify(exclusions) !== JSON.stringify(DEFAULT_EXCLUSIONS)) throw new Error('exclusion policy invalid');
  return [...DEFAULT_EXCLUSIONS];
}
async function assertSafeRoot(root: string): Promise<{ root: string; physical: string }> {
  if (!isAbsolute(root)) throw new Error('root must be absolute');
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('root must be a non-symlink directory');
  const physical = await realpath(root);
  return { root: resolve(root), physical };
}
async function walk(root: string, physicalRoot: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = join(current, entry.name);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new Error(`symlink rejected: ${relative(root, absolute)}`);
    const rel = relative(root, absolute).split(sep).join('/');
    if (isExcludedByPolicy(rel, DEFAULT_EXCLUSIONS)) continue;
    const physical = await realpath(absolute);
    const containment = relative(physicalRoot, physical);
    if (containment === '..' || containment.startsWith(`..${sep}`) || isAbsolute(containment)) throw new Error(`physical escape: ${rel}`);
    if (info.isDirectory()) files.push(...await walk(root, physicalRoot, absolute));
    else if (info.isFile()) files.push(rel);
  }
  return files;
}
async function fileMetadata(root: string, path: string): Promise<BaselineFile> {
  const rel = normalize(path);
  if (rel === '.') throw new Error('file path cannot be root');
  const absolute = join(root, ...rel.split('/'));
  const info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`symlink or non-file rejected: ${rel}`);
  const bytes = await readFile(absolute);
  return { path: rel, bytes: bytes.byteLength, mode: info.mode & 0o777, sha256: createHash('sha256').update(bytes).digest('hex') };
}

export async function buildBaselineManifest(root: string, options: { allowlist: string[]; exclusions?: string[]; snapshot?: { path: string; sha256: string } }): Promise<BaselineManifest> {
  const safe = await assertSafeRoot(root);
  const allowlist = validateAllowlist(options.allowlist);
  const exclusions = validateExclusions(options.exclusions ?? DEFAULT_EXCLUSIONS);
  const discovered = (await walk(safe.root, safe.physical)).filter(p => allowed(p, allowlist)).sort();
  return { version: 1, root: safe.root, files: await Promise.all(discovered.map(p => fileMetadata(safe.root, p))), allowlist, exclusions, toolVersion: TOOL_VERSION, snapshot: options.snapshot, completeness: 'complete', extrasPolicy: 'reject-non-excluded', symlinkPolicy: 'reject-root-and-internal' };
}

export async function verifyBaselineManifest(root: string, manifest: BaselineManifest): Promise<ManifestCheck> {
  const errors: string[] = [];
  let safe: { root: string; physical: string };
  try { safe = await assertSafeRoot(root); } catch (e) { return { valid: false, errors: [String(e instanceof Error ? e.message : e)] }; }
  if (!manifest || typeof manifest !== 'object') return { valid: false, errors: ['manifest must be an object'] };
  if (!manifest || typeof manifest !== 'object' || manifest.version !== 1 || manifest.completeness !== 'complete' || manifest.extrasPolicy !== 'reject-non-excluded' || manifest.symlinkPolicy !== 'reject-root-and-internal' || typeof manifest.toolVersion !== 'string') errors.push('manifest policy invalid');
  if (manifest.root !== safe.root) errors.push('manifest root mismatch');
  if (manifest.snapshot !== undefined && (!manifest.snapshot || typeof manifest.snapshot.path !== 'string' || !isAbsolute(manifest.snapshot.path) || !/^[a-f0-9]{64}$/i.test(manifest.snapshot.sha256))) errors.push('snapshot metadata invalid');
  let allowlist: string[] = [];
  try { allowlist = validateAllowlist(manifest.allowlist); } catch (e) { errors.push(String(e instanceof Error ? e.message : e)); }
  try { validateExclusions(manifest.exclusions); } catch (e) { errors.push(String(e instanceof Error ? e.message : e)); }
  if (!Array.isArray(manifest.files)) errors.push('files must be an array');
  const candidates: BaselineFile[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(manifest.files) ? manifest.files : []) {
    if (!item || typeof item !== 'object' || typeof item.path !== 'string' || typeof item.bytes !== 'number' || !Number.isInteger(item.bytes) || item.bytes < 0 || typeof item.mode !== 'number' || !Number.isInteger(item.mode) || item.mode < 0 || item.mode > 0o777 || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(item.sha256)) { errors.push('file metadata invalid'); continue; }
    let path: string;
    try { path = normalize(item.path); } catch (e) { errors.push(String(e instanceof Error ? e.message : e)); continue; }
    if (path !== item.path) { errors.push(`${item.path} is not normalized`); continue; }
    if (!allowlist.some(entry => entry === '.' || path === entry || path.startsWith(`${entry}/`))) { errors.push(`${path} outside allowlist`); continue; }
    if (isExcludedByPolicy(path, manifest.exclusions ?? DEFAULT_EXCLUSIONS)) { errors.push(`${path} is excluded`); continue; }
    if (seen.has(path)) { errors.push(`${path} duplicate`); continue; }
    seen.add(path); candidates.push({ ...item, path });
  }
  if (errors.length) return { valid: false, errors };
  const expected = new Set<string>();
  for (const item of candidates) {
    try {
      const actual = await fileMetadata(safe.root, item.path); expected.add(item.path);
      for (const key of ['bytes', 'mode', 'sha256'] as const) if (actual[key] !== item[key]) errors.push(`${item.path} ${key} mismatch`);
    } catch { errors.push(`${item.path} missing or unsafe`); }
  }
  try {
    const discovered = (await walk(safe.root, safe.physical)).filter(p => allowed(p, manifest.allowlist ?? []));
    for (const extra of discovered) if (!expected.has(extra)) errors.push(`${extra} extra non-excluded file`);
  } catch (e) { errors.push(String(e instanceof Error ? e.message : e)); }
  return { valid: errors.length === 0, errors };
}

export type SchemaValidationResult = { valid: boolean; schemas: string[]; errors?: string[] };
export async function validateInputSchemas(directory: string, options: { fixtures?: Record<string, unknown>; invalidFixtures?: Record<string, unknown> } = {}): Promise<SchemaValidationResult> {
  const names = (await readdir(directory)).filter(name => name.endsWith('.json')).sort();
  const required = ['catalog-entry.v2.json', 'catalog-relation.v2.json', 'catalog-source.v2.json', 'memory-record.v1.json'];
  const errors: string[] = [];
  if (names.length !== required.length || required.some(name => !names.includes(name))) errors.push(`expected exactly four input schemas: ${required.join(', ')}`);
  const ajv = new Ajv2020({ strict: true, allErrors: true }); addFormats(ajv);
  const validators = new Map<string, ValidateFunction>();
  for (const name of names) {
    try { const schema = JSON.parse(await readFile(join(directory, name), 'utf8')); validators.set(name, ajv.compile(schema)); }
    catch (e) { errors.push(`${name} schema compile/keyword error: ${e instanceof Error ? e.message : String(e)}`); }
  }
  for (const [name, fixture] of Object.entries(options.fixtures ?? {})) {
    const validator = validators.get(name);
    if (!validator) { errors.push(`${name} unknown fixture schema`); continue; }
    if (!validator(fixture)) errors.push(`${name} invalid fixture: ${formatAjvErrors(validator.errors)}`);
  }
  for (const [name, fixture] of Object.entries(options.invalidFixtures ?? {})) {
    const validator = validators.get(name);
    if (!validator) { errors.push(`${name} unknown invalid fixture schema`); continue; }
    if (validator(fixture)) errors.push(`${name} accepted invalid fixture`);
  }
  return errors.length ? { valid: false, schemas: names, errors } : { valid: true, schemas: names };
}
function formatAjvErrors(errors: ErrorObject[] | null | undefined): string { return (errors ?? []).map(e => `${e.instancePath} ${e.keyword}`).join(', '); }
