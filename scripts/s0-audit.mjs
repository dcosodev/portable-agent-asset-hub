import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { buildBaselineManifest, validateBaselineArchiveEntries, verifyBaselineManifest } from '../dist/packages/baseline/index.js';
import { S0_TRUST_ANCHOR } from './s0-trust-anchor.mjs';

const hub = fileURLToPath(new URL('..', import.meta.url));
const manifestPath = join(hub, 'docs/baseline/current-repo-manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const resolvedRoot = resolve(hub, manifest.root);
const resolvedSnapshot = resolve(hub, manifest.snapshot.path);
const runtimeManifest = { ...manifest, root: resolvedRoot, snapshot: { ...manifest.snapshot, path: resolvedSnapshot } };
const check = await verifyBaselineManifest(resolvedRoot, runtimeManifest);
if (!check.valid) throw new Error(`baseline verify failed: ${check.errors.join('; ')}`);
if (!manifest.snapshot || manifest.snapshot.path !== S0_TRUST_ANCHOR.snapshotPath || manifest.snapshot.sha256.toLowerCase() !== S0_TRUST_ANCHOR.snapshotSha256) throw new Error('manifest snapshot does not match immutable S0 trust anchor');
const tar = resolvedSnapshot;
const canonicalTar = await realpath(tar);
if (canonicalTar !== tar || !tar.startsWith('/')) throw new Error('snapshot path is not canonical');
const bytes = await readFile(tar);
const digest = createHash('sha256').update(bytes).digest('hex');
if (digest !== manifest.snapshot.sha256) throw new Error('snapshot hash does not match manifest');
const sidecar = `${tar}.sha256`;
const sidecarText = await readFile(sidecar, 'utf8');
const sidecarMatch = sidecarText.trim().match(/^([a-f0-9]{64})\s+(.+)$/i);
const sidecarPath = sidecarMatch ? await realpath(sidecarMatch[2]).catch(() => '') : '';
if (!sidecarMatch || sidecarMatch[1].toLowerCase() !== digest || sidecarPath !== tar) throw new Error('snapshot sidecar does not match manifest');
await stat(tar);
const listing = execFileSync('tar', ['-tvzf', tar], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
const archiveEntries = listing.map(line => {
  const type = line[0] === 'd' ? 'directory' : line[0] === 'l' ? 'symlink' : line[0] === 'h' ? 'hardlink' : line[0] === '-' ? 'file' : 'unknown';
  const match = line.match(/^.{10}\s+\d+\s+\S+\s+\S+\s+\d+\s+\w{3}\s+\d{1,2}\s+[\d:]+\s+(.+)$/);
  if (!match || type === 'unknown') throw new Error(`unparseable or unsupported archive entry: ${line}`);
  return { path: match[1].replace(/\s+->\s+.*$/, ''), type };
});
const entries = archiveEntries.map(entry => entry.path);
const forbidden = validateBaselineArchiveEntries(archiveEntries);
if (forbidden.length) throw new Error(`forbidden archive entries: ${forbidden.join(', ')}`);
const restore = await mkdtemp(join(tmpdir(), 'pah-restore-'));
try {
  execFileSync('tar', ['-xzf', tar, '-C', restore]);
  const restoredRoot = join(restore, 'agent-memory');
  const restored = await buildBaselineManifest(restoredRoot, { allowlist: manifest.allowlist, exclusions: manifest.exclusions });
  const logical = x => JSON.stringify(x.files);
  if (logical(restored) !== logical(manifest)) throw new Error('restored manifest differs from source manifest');
  console.log(JSON.stringify({ manifestFiles: manifest.files.length, archiveEntries: entries.length, forbidden: 0, restored: true }));
} finally { await rm(restore, { recursive: true, force: true }); }
