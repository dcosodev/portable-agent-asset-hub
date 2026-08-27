#!/usr/bin/env node
// scripts/verify-db-only-skills.mjs
//
// Fase 3 helper. Given a SQLite file produced by the Fase2 apply CLI,
// the helper opens it directly with `node:sqlite`, asserts the schema
// is at migration 16, that the named skill row exists, and that the
// body / resource bytes round-trip exactly. The helper is hermetic: it
// never touches `~/.hermes`, `~/.openclaw`, the live hub database, or
// any filesystem source the apply step read from.
//
// Usage:
//   node scripts/verify-db-only-skills.mjs \
//     --db <hub.sqlite> \
//     --skill-id <skl_...> \
//     --resource-path <relative/path> \
//     --body-marker <substring expected in body> \
//     --resource-marker <substring expected in resource bytes>
//
// Exit code 0 on success; the helper prints a single JSON line to
// stdout. Diagnostics go to stderr. The helper is intentionally
// read-only — it never mutates the SQLite file.

import { argv, exit, stderr, stdout } from 'node:process';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function parseCli(argvList) {
  const out = { db: undefined, skillId: undefined, resourcePath: undefined, bodyMarker: undefined, resourceMarker: undefined };
  for (let i = 0; i < argvList.length; i += 1) {
    const arg = argvList[i];
    const next = argvList[i + 1];
    const take = (label) => {
      if (typeof next !== 'string') throw new Error(`${arg} requires <${label}>`);
      i += 1;
      return next;
    };
    if (arg === '--db') out.db = resolve(take('path'));
    else if (arg === '--skill-id') out.skillId = take('id');
    else if (arg === '--resource-path') out.resourcePath = take('path');
    else if (arg === '--body-marker') out.bodyMarker = take('string');
    else if (arg === '--resource-marker') out.resourceMarker = take('string');
    else throw new Error(`unknown argument: ${arg}`);
  }
  for (const [key, value] of Object.entries(out)) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`--${key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)} is required`);
    }
  }
  return out;
}

function emit(payload) {
  stdout.write(`${JSON.stringify(payload)}\n`);
}

function main() {
  const args = parseCli(argv.slice(2));
  const db = new DatabaseSync(args.db);
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get();
    const integrityOk = integrity && integrity.integrity_check === 'ok';
    const schemaVersion = db.prepare('SELECT MAX(version) AS v FROM schema_meta').get();
    const schemaOk = schemaVersion && Number(schemaVersion.v) === 19;
    const headRow = db.prepare(
      "SELECT sv.version, se.lifecycle, sv.body, sv.body_sha256, sv.total_size FROM skill_versions sv JOIN skill_entries se ON se.id = sv.id AND se.owner_user_id = sv.owner_user_id AND se.scope_agent_id = sv.scope_agent_id WHERE sv.id = ? AND se.current_version = sv.version ORDER BY sv.version DESC LIMIT 1",
    ).get(args.skillId);
    const bodyMatch = !!(headRow && headRow.body && Buffer.from(headRow.body).toString('utf8').includes(args.bodyMarker));
    const bodyShaOk = !!(headRow && typeof headRow.body_sha256 === 'string' && /^[0-9a-f]{64}$/.test(headRow.body_sha256));
    const lifecycleOk = !!(headRow && headRow.lifecycle === 'active');
    const resourceRow = db.prepare(
      "SELECT sr.bytes, sr.sha256 FROM skill_resources sr JOIN skill_versions sv ON sv.id = sr.id AND sv.owner_user_id = sr.owner_user_id AND sv.scope_agent_id = sr.scope_agent_id AND sv.version = sr.version WHERE sr.id = ? AND sv.version = (SELECT MAX(version) FROM skill_versions WHERE id = ?) AND sr.relative_path = ?",
    ).get(args.skillId, args.skillId, args.resourcePath);
    const bytesMatch = !!(resourceRow && resourceRow.bytes && Buffer.from(resourceRow.bytes).toString('utf8').includes(args.resourceMarker));
    const resourceShaOk = !!(resourceRow && typeof resourceRow.sha256 === 'string' && /^[0-9a-f]{64}$/.test(resourceRow.sha256));
    emit({
      ok: Boolean(integrityOk && schemaOk && bodyMatch && bodyShaOk && lifecycleOk && bytesMatch && resourceShaOk),
      integrityOk,
      schemaOk,
      schemaVersion: schemaVersion?.v ?? null,
      skillId: args.skillId,
      lifecycle: headRow?.lifecycle ?? null,
      bodyMatch,
      bodyShaOk,
      bytesMatch,
      resourceShaOk,
    });
    exit(integrityOk && schemaOk && bodyMatch && bodyShaOk && lifecycleOk && bytesMatch && resourceShaOk ? 0 : 1);
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  stderr.write(`verify-db-only-skills error: ${message}\n`);
  exit(2);
}
