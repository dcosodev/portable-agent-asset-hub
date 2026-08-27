// packages/core/src/importer/secret-scan.ts
//
// Phase 2 high-confidence secret scanner for skill pack resources.
//
// Contract:
//   * Match-only; values are NEVER returned. Callers only see the
//     rule name, rootId and relative path.
//   * The rules are narrow enough to keep false positives low — we
//     avoid catching obvious placeholders (`${VAR}`, `YOUR_TOKEN_HERE`,
//     `example.com`) so legitimate skill documentation is not blocked.
//
// The scanner is shared between the preview step and the apply step.
// The apply step re-runs the same scan on freshly read bytes to defeat
// TOCTOU substitutions. The function is pure: no I/O, no time, no
// hidden state. Errors surface as HubError so callers can decide
// whether to log them; the scan itself never throws on a malformed
// buffer.

import { createHash } from 'node:crypto';

import type { SkillSecretFinding } from './types.js';

interface Rule {
  name: string;
  expression: RegExp;
}

const HEADER_RULES: Rule[] = [
  { name: 'private-key-header', expression: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/u },
  { name: 'rsa-key-header', expression: /-----BEGIN RSA PRIVATE KEY-----/u },
];

const TOKEN_RULES: Rule[] = [
  { name: 'aws-access-key-id', expression: /\bAKIA[0-9A-Z]{16}\b/u },
  { name: 'aws-secret-access-key', expression: /\b(?:aws_)?secret_access_key\s*=\s*[A-Za-z0-9/+=]{40}\b/u },
  { name: 'github-token', expression: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/u },
  { name: 'openai-style-token', expression: /\bsk-[A-Za-z0-9_-]{32,}\b/u },
  { name: 'slack-token', expression: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/u },
  { name: 'stripe-key', expression: /\bsk_live_[A-Za-z0-9]{20,}\b/u },
  { name: 'jwt', expression: /\bey[A-Za-z0-9_-]{10,}\.ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u },
];

const PLACEHOLDER_PATTERNS: RegExp[] = [
  /\bexample\b/iu,
  /\bplaceholder\b/iu,
  /\bredacted\b/iu,
  /\bchangeme\b/iu,
  /\byour[_-]/iu,
  /\bdummy\b/iu,
  /\bsample\b/iu,
  /<[^>]+>/u,
  /\$\{/u,
  /\$\(/u,
  /\bprocess\.env\b/iu,
  /\benv\[/iu,
];

const PLACEHOLDER_COMBINED = new RegExp(
  `(${PLACEHOLDER_PATTERNS.map((pattern) => pattern.source).join('|')})`,
  'iu',
);

const ASSIGNMENT_RULE = /\b(?:api[_-]?key|token|password|secret|client[_-]?secret|access[_-]?token)\b\s*[:=]\s*["']?([^\s"'#,;]{24,})/giu;

function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let result = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    result -= probability * Math.log2(probability);
  }
  return result;
}

export function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_COMBINED.test(value);
}

/**
 * Stable (order-independent) deduper for findings. The preview and
 * apply steps both rely on a deterministic findings list so the
 * `details` payload is byte-stable.
 */
function dedupeFindings(findings: SkillSecretFinding[]): SkillSecretFinding[] {
  const seen = new Set<string>();
  const out: SkillSecretFinding[] = [];
  for (const finding of findings) {
    const key = `${finding.rootId}\u0000${finding.path}\u0000${finding.rule}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(finding);
  }
  return out;
}

/**
 * Scan a single buffer. The buffer is decoded as utf-8 with lossy
 * semantics so surrounding text is still inspected around non-utf8
 * bytes. Returns zero or more findings — NEVER the matched values
 * themselves.
 */
export function scanBuffer(
  bytes: Buffer,
  meta: { rootId: string; relativePath: string; isText: boolean },
): SkillSecretFinding[] {
  const findings: SkillSecretFinding[] = [];
  const text = bytes.toString('utf8');

  for (const rule of HEADER_RULES) {
    if (rule.expression.test(text)) {
      findings.push({ rootId: meta.rootId, path: meta.relativePath, rule: rule.name });
      break;
    }
  }

  for (const rule of TOKEN_RULES) {
    if (rule.expression.test(text)) {
      findings.push({ rootId: meta.rootId, path: meta.relativePath, rule: rule.name });
      break;
    }
  }

  if (meta.isText) {
    for (const match of text.matchAll(ASSIGNMENT_RULE)) {
      const value = match[1] ?? '';
      if (!value || isPlaceholder(value)) continue;
      const hasLetters = /[A-Za-z]/u.test(value);
      const hasDigits = /[0-9]/u.test(value);
      if (!hasLetters || !hasDigits) continue;
      if (shannonEntropy(value) < 3.5) continue;
      findings.push({ rootId: meta.rootId, path: meta.relativePath, rule: 'high-entropy-secret-assignment' });
      break;
    }
  }

  return dedupeFindings(findings);
}

/**
 * Convenience helper used by the CLI/tests: returns true if scanning
 * `bytes` produces at least one finding.
 */
export function hasSecretFindings(
  bytes: Buffer,
  meta: { rootId: string; relativePath: string; isText: boolean },
): boolean {
  return scanBuffer(bytes, meta).length > 0;
}

/** sha256 helper used by the storage-files importer. Pure. */
export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
