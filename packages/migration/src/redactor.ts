// packages/migration/src/redactor.ts
//
// Slice 10 redactor. Walks a record and replaces every SECRET-classified
// leaf with the literal string '__REDACTED__'. The shape of the input
// is preserved: nested objects stay nested objects, arrays stay arrays,
// and non-secret values pass through unchanged.
//
// The redactor is the boundary enforcer: callers MUST run any payload
// that crosses a process or storage boundary (export NDJSON, audit
// log, replay diff, …) through redactPayload() before emitting it.

import { classifyFields, isSecretKey, type ClassifiedValue } from './classifier.js';

export const REDACTED_VALUE = '__REDACTED__';

export function redactPayload<T>(input: T): T {
  return redactInternal(input, new WeakSet()) as T;
}

function redactInternal(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return value;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item !== null && typeof item === 'object') return redactInternal(item, seen);
      return item;
    });
  }

  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isSecretKey(key)) {
      out[key] = REDACTED_VALUE;
      continue;
    }
    if (child !== null && typeof child === 'object') {
      out[key] = redactInternal(child, seen);
    } else {
      out[key] = child;
    }
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Internal helper exposed for callers that want a single-pass
// "classify-and-redact" view of a payload (e.g. for diagnostics).
export function classifyAndRedact<T>(input: T): { classified: ClassifiedValue; redacted: T } {
  return {
    classified: classifyFields(input as unknown),
    redacted: redactPayload(input),
  };
}
