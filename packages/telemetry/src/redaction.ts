/**
 * Redaction helpers for the telemetry kernel.
 *
 * The kernel refuses to forward any key outside the allowlist declared in
 * `attributes.ts` AND scrubs well-known secret patterns from attribute values
 * before they reach an exporter. This file is the second line of defense: even
 * if a caller forgets to scrub, the exporter receives a sanitized payload.
 *
 * Diagnostics MUST NOT echo the raw offending value verbatim. We only describe
 * the failure category so a log capture cannot reconstruct secrets or query
 * strings from them.
 */

import {
  ALLOWED_METRIC_LABEL_KEYS,
  ALLOWED_SPAN_ATTRIBUTE_KEYS,
} from './attributes.js';

const REDACTED = '[redacted]';

/**
 * Patterns matched against attribute VALUES. Anything that looks like a
 * credential, JWT, PEM block, password / token / api_key assignment or OTLP
 * header is replaced with `[redacted]`. Patterns are intentionally narrow:
 * we want to redact secrets, not truncate legitimate attribute values.
 */
const VALUE_PATTERNS: readonly RegExp[] = [
  // Bearer / Authorization scheme with token payload
  /\bBearer\s+[A-Za-z0-9._\-+/=]{8,}/gi,
  // Raw JWTs (header.payload.signature)
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_+/=-]{8,}/g,
  // Loose JWT (header only — sometimes seen when only the prefix survives)
  /\beyJ[A-Za-z0-9_-]{16,}/g,
  // PEM block markers + content
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // password=... (or "password": "...") up to whitespace/comma/quote boundary
  /(password|passwd|pwd)\s*[=:]\s*['"]?[^\s'",;}]{4,}['"]?/gi,
  // api_key=... / apiKey=...
  /(api[_-]?key|apikey)\s*[=:]\s*['"]?[^\s'",;}]{4,}['"]?/gi,
  // token=... / access_token / bearer_token (token, not authorization)
  /(access[_-]?token|bearer[_-]?token|secret[_-]?token|\btoken)\s*[=:]\s*['"]?[^\s'",;}]{4,}['"]?/gi,
];

/**
 * Patterns matched against SPAN NAMES. Anything that looks like a query string
 * (`?secret=abc`), a JSON body, a raw URL with credentials, etc. is stripped.
 */
const SPAN_NAME_TAIL_PATTERNS: readonly RegExp[] = [
  // query string suffix
  /\?[^ \t\n]*/g,
  // JSON-ish body suffix
  /\s*\{[^}]*\}/g,
  // raw URL with credentials
  /\/\/[^@\s]+:[^@\s]+@/g,
];

/**
 * Replace secret-shaped substrings with `[redacted]`. Operates on a string and
 * always returns a string. Non-string values are coerced via `String()` so
 * numeric and boolean attributes still flow through.
 */
export function redactAttributeValue(_key: string, value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : String(value);
  if (text.length === 0) return text;
  let out = text;
  for (const pattern of VALUE_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/**
 * Keep only allowlisted span attribute keys AND scrub every remaining value
 * for known secret patterns. Forbidden keys are dropped silently — telemetry
 * must never surface query, body, header values or arbitrary IDs.
 */
export function scrubAttributes(
  attrs: Record<string, unknown> | undefined,
): Record<string, string | number | boolean> {
  if (!attrs) return {};
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (!ALLOWED_SPAN_ATTRIBUTE_KEYS.has(k)) continue;
    if (v === null || v === undefined) continue;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) continue;
      out[k] = v;
    } else if (typeof v === 'boolean') {
      out[k] = v;
    } else {
      const scrubbed = redactAttributeValue(k, v);
      if (scrubbed.length > 0) out[k] = scrubbed;
    }
  }
  return out;
}

/**
 * Keep only allowlisted metric label keys AND scrub their string values.
 * Metric labels are restricted by cardinality contract; non-allowed keys are
 * dropped silently.
 */
export function scrubMetricLabels(
  labels: Record<string, unknown> | undefined,
): Record<string, string> {
  if (!labels) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(labels)) {
    if (!ALLOWED_METRIC_LABEL_KEYS.has(k)) continue;
    if (v === null || v === undefined) continue;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) continue;
      out[k] = String(v);
    } else if (typeof v === 'boolean') {
      out[k] = v ? 'true' : 'false';
    } else {
      const scrubbed = redactAttributeValue(k, v);
      if (scrubbed.length > 0) out[k] = scrubbed;
    }
  }
  return out;
}

/**
 * Sanitize a span name. Anything that looks like a raw URL query, a JSON body
 * or credentials embedded in a URL is stripped. The remaining structure is
 * preserved when the caller follows the `verb /path` convention; otherwise
 * the full name is wrapped under the `hub.http` namespace so that downstream
 * filtering keeps a single, predictable root.
 */
export function scrubSpanName(name: string): string {
  if (!name) return 'hub.http';
  let cleaned = name;
  for (const pattern of SPAN_NAME_TAIL_PATTERNS) {
    pattern.lastIndex = 0;
    cleaned = cleaned.replace(pattern, '');
  }
  cleaned = cleaned.trim().replace(/\s+/g, ' ');
  // If the cleaned name still contains raw PII (e.g. a path that survived
  // because it had no query/body suffix) we leave it intact: the allowlist
  // for span attributes is enforced separately and the kernel never uses
  // the span name to carry credentials.
  if (cleaned.length === 0) return 'hub.http';
  // Heuristic: HTTP-shaped names (verb + path) get the hub.http prefix.
  if (/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+\//i.test(cleaned)) {
    return `hub.http ${cleaned}`;
  }
  if (/^hub\./.test(cleaned)) return cleaned;
  return `hub.http ${cleaned}`;
}