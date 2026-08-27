// packages/runtime-adapters/src/preview.ts
//
// The preview pipeline. Given (harness, targetDir, profile, agentId,
// userFile, soulFile, restUrl, mcpEntry) it:
//
//   1. Validates the target directory (existing, non-symlink, absolute).
//   2. Validates the USER / SOUL file paths (existing, non-symlink, file).
//   3. Reads the canonical USER / SOUL bytes, hashes them, records
//      sha256 + size — but never includes the bytes in the returned
//      `Preview`.
//   4. Renders the harness wrapper.
//   5. Builds the descriptor body + command fragments.
//   6. Compiles a `Preview` object + the canonical manifest digest.
//
// The preview never writes to the target directory. The apply is
// the only writer.

import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import type {
  CommandFragment,
  DescriptorBody,
  DescriptorPreview,
  HarnessId,
  PlanFile,
  PlanDigest,
  Preview,
  PreviewInput,
  Renderer,
} from './contracts.js';
import { digestManifest, sha256 } from './internal/digest.js';
import { assertSafeMode, SAFE_DEFAULT_MODE } from './internal/safe-mode.js';
import { assertSafeRelativePath } from './internal/safe-paths.js';
import { assertSafeTargetDir } from './internal/safe-target.js';
import { getRenderer } from './registry.js';

import {
  CODEX_TOML_RELATIVE_PATH,
  serialiseCodexToml,
} from './codex/implementation.js';
import {
  CODEX_USER_RELATIVE_PATH,
  CODEX_SOUL_RELATIVE_PATH,
} from './codex/paths.js';

import {
  CLAUDE_MCP_JSON_RELATIVE_PATH,
  serialiseClaudeMcpJson as serialiseClaude,
} from './claude-code/implementation.js';
import {
  CLAUDE_USER_RELATIVE_PATH,
  CLAUDE_SOUL_RELATIVE_PATH,
} from './claude-code/paths.js';

import {
  OPENCODE_OPENCODE_JSON_RELATIVE_PATH,
  serialiseOpenCodeJson as serialiseOpenCode,
} from './opencode/implementation.js';
import {
  OPENCODE_USER_RELATIVE_PATH,
  OPENCODE_SOUL_RELATIVE_PATH,
} from './opencode/paths.js';

import {
  HERMES_DESCRIPTOR_RELATIVE_PATH,
  serialiseHermesCommandFragment,
  renderHermesCommandFragments,
} from './hermes/implementation.js';
import {
  HERMES_USER_RELATIVE_PATH,
  HERMES_SOUL_RELATIVE_PATH,
} from './hermes/paths.js';

import {
  OPENCLAW_FRAGMENT_RELATIVE_PATH,
  serialiseOpenclawFragment,
  renderOpenclawCommandFragments,
} from './openclaw/implementation.js';
import {
  OPENCLAW_USER_RELATIVE_PATH,
  OPENCLAW_SOUL_RELATIVE_PATH,
} from './openclaw/paths.js';

import { renderCodexCommandFragments } from './codex/implementation.js';
import { renderClaudeCommandFragments } from './claude-code/implementation.js';
import { renderOpenCodeCommandFragments } from './opencode/implementation.js';

function readCanonicalInput(absolutePath: string, label: string): Uint8Array {
  if (!isAbsolute(absolutePath)) {
    throw new Error(`${label} must be absolute: ${absolutePath}`);
  }
  const resolved = resolve(absolutePath);
  if (!existsSync(resolved)) {
    throw new Error(`${label} not found: ${resolved}`);
  }
  const stat = lstatSync(resolved);
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink: ${resolved}`);
  }
  if (!stat.isFile()) {
    throw new Error(`${label} must be a regular file: ${resolved}`);
  }
  return new Uint8Array(readFileSync(resolved));
}

function logicalId(raw: string, kind: 'agent' | 'profile'): string {
  if (typeof raw !== 'string' || raw.length === 0 || !/^[A-Za-z0-9._-]{1,128}$/u.test(raw)) {
    throw new Error(`${kind} id must match /^[A-Za-z0-9._-]{1,128}$/: ${raw}`);
  }
  return raw;
}

function requireRestUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error('restUrl required');
  try {
    const parsed = new URL(trimmed);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`;
  } catch (error) {
    throw new Error(`restUrl must be a valid URL: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

function requireMcpEntry(value: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('mcpEntry required');
  if (!isAbsolute(value)) throw new Error(`mcpEntry must be absolute: ${value}`);
  const resolved = resolve(value);
  if (!existsSync(resolved)) throw new Error(`mcpEntry not found: ${resolved}`);
  return resolved;
}

function requireTokenFile(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!isAbsolute(value)) throw new Error(`authTokenFile must be absolute: ${value}`);
  const resolved = resolve(value);
  const stat = existsSync(resolved) ? lstatSync(resolved) : undefined;
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) throw new Error(`authTokenFile must be a regular non-symlink file: ${resolved}`);
  if ((stat.mode & 0o077) !== 0) throw new Error(`authTokenFile must have restrictive permissions: ${resolved}`);
  return resolved;
}

function buildPlanFile(relativePath: string, bytes: Uint8Array, mode: number, sourceRef: string): PlanFile {
  assertSafeRelativePath(relativePath);
  const safeMode = assertSafeMode(mode);
  return {
    relativePath,
    sha256: sha256(bytes),
    size: bytes.byteLength,
    mode: safeMode,
    bytes,
    sourceRef,
  };
}

function descriptorRelativePath(harness: HarnessId): string {
  switch (harness) {
    case 'codex': return CODEX_TOML_RELATIVE_PATH;
    case 'claude-code': return CLAUDE_MCP_JSON_RELATIVE_PATH;
    case 'opencode': return OPENCODE_OPENCODE_JSON_RELATIVE_PATH;
    case 'hermes': return HERMES_DESCRIPTOR_RELATIVE_PATH;
    case 'openclaw': return OPENCLAW_FRAGMENT_RELATIVE_PATH;
  }
}

function userRelativePath(harness: HarnessId): string {
  switch (harness) {
    case 'codex': return CODEX_USER_RELATIVE_PATH;
    case 'claude-code': return CLAUDE_USER_RELATIVE_PATH;
    case 'opencode': return OPENCODE_USER_RELATIVE_PATH;
    case 'hermes': return HERMES_USER_RELATIVE_PATH;
    case 'openclaw': return OPENCLAW_USER_RELATIVE_PATH;
  }
}

function soulRelativePath(harness: HarnessId): string {
  switch (harness) {
    case 'codex': return CODEX_SOUL_RELATIVE_PATH;
    case 'claude-code': return CLAUDE_SOUL_RELATIVE_PATH;
    case 'opencode': return OPENCODE_SOUL_RELATIVE_PATH;
    case 'hermes': return HERMES_SOUL_RELATIVE_PATH;
    case 'openclaw': return OPENCLAW_SOUL_RELATIVE_PATH;
  }
}

function serialiseDescriptor(harness: HarnessId, body: DescriptorBody): string {
  switch (harness) {
    case 'codex': {
      if (body.kind !== 'codex-toml') throw new Error('codex descriptor kind mismatch');
      return serialiseCodexToml(body);
    }
    case 'claude-code': {
      if (body.kind !== 'claude-code-mcp-json') throw new Error('claude-code descriptor kind mismatch');
      return serialiseClaude(body);
    }
    case 'opencode': {
      if (body.kind !== 'opencode-opencode-json') throw new Error('opencode descriptor kind mismatch');
      return serialiseOpenCode(body);
    }
    case 'hermes': {
      if (body.kind !== 'hermes-cli-fragment') throw new Error('hermes descriptor kind mismatch');
      return serialiseHermesCommandFragment(body);
    }
    case 'openclaw': {
      if (body.kind !== 'openclaw-mcp-fragment') throw new Error('openclaw descriptor kind mismatch');
      return serialiseOpenclawFragment(body);
    }
  }
}

function commandFragmentsFor(renderer: Renderer, input: PreviewInput): readonly CommandFragment[] {
  switch (renderer.id) {
    case 'codex':
      return renderCodexCommandFragments(input);
    case 'claude-code':
      return renderClaudeCommandFragments(input);
    case 'opencode':
      return renderOpenCodeCommandFragments(input);
    case 'hermes':
      return renderHermesCommandFragments(input);
    case 'openclaw':
      return renderOpenclawCommandFragments(input);
  }
}

export function computePreview(input: PreviewInput): Preview {
  const target = assertSafeTargetDir(input.targetDir);
  const userFile = readCanonicalInput(input.userFile, 'userFile');
  const soulFile = readCanonicalInput(input.soulFile, 'soulFile');
  const restUrl = requireRestUrl(input.restUrl);
  const mcpEntry = requireMcpEntry(input.mcpEntry);
  const authTokenFile = requireTokenFile(input.authTokenFile);
  const profile = logicalId(input.profile, 'profile');
  const agentId = logicalId(input.agentId ?? 'agent_default', 'agent');

  const validated: PreviewInput = {
    ...input,
    targetDir: target.absolute,
    profile,
    agentId,
    restUrl,
    mcpEntry,
    authTokenFile,
  };

  const renderer = getRenderer(input.harness);
  const wrapperBytes = renderer.renderWrapper(validated);
  const userCopyBytes = renderer.renderUserCopy(userFile);
  const soulCopyBytes = renderer.renderSoulCopy(soulFile);
  const descriptorBody = renderer.renderDescriptor(validated);

  const wrapperRelativePath = assertSafeRelativePath(renderer.wrapperRelativePath);
  const userRelative = userRelativePath(input.harness);
  const soulRelative = soulRelativePath(input.harness);
  const descriptorRelative = descriptorRelativePath(input.harness);

  const descriptorText = serialiseDescriptor(input.harness, descriptorBody);
  const descriptorRawBytes = new TextEncoder().encode(descriptorText);

  const files: PlanFile[] = [
    buildPlanFile(wrapperRelativePath, wrapperBytes, SAFE_DEFAULT_MODE, `template:${input.harness}-wrapper`),
    buildPlanFile(userRelative, userCopyBytes, SAFE_DEFAULT_MODE, 'canonical-user'),
    buildPlanFile(soulRelative, soulCopyBytes, SAFE_DEFAULT_MODE, 'canonical-soul'),
    buildPlanFile(descriptorRelative, descriptorRawBytes, SAFE_DEFAULT_MODE, `descriptor:${input.harness}`),
  ];

  const commandFragments = commandFragmentsFor(renderer, validated);

  const commandsDigestable = commandFragments.map((fragment) => ({
    label: fragment.label,
    argv: [...fragment.argv],
    env: Object.fromEntries(Object.keys(fragment.env).sort().map((key) => [key, fragment.env[key]!])),
  }));

  const digest = digestManifest({
    harness: input.harness,
    profile,
    agentId,
    targetDir: target.absolute,
    restUrl,
    mcpEntry,
    wrapperRelativePath,
    files: files.map((file) => ({
      relativePath: file.relativePath,
      sha256: file.sha256,
      size: file.size,
      mode: file.mode,
      sourceRef: file.sourceRef,
    })),
    descriptor: descriptorBody,
    commandFragments: commandsDigestable,
  });

  const planDigest: PlanDigest = {
    digest,
    algorithm: 'sha256',
    canonicalisedAt: '1970-01-01T00:00:00.000Z',
  };

  const descriptor: DescriptorPreview = {
    relativePath: descriptorRelative,
    kind: descriptorBody.kind,
    body: descriptorBody,
  };

  return {
    planDigest,
    harness: input.harness,
    profile,
    agentId,
    targetDir: target.absolute,
    restUrl,
    mcpEntry,
    userFile: resolve(input.userFile),
    soulFile: resolve(input.soulFile),
    wrapperRelativePath,
    files,
    descriptor,
    commandFragments,
    generatedAt: planDigest.canonicalisedAt,
  };
}
