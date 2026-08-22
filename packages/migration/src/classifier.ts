// packages/migration/src/classifier.ts
//
// Slice 10 data classifier. Walks a record and assigns each leaf a
// classification from {PUBLIC, INTERNAL, SENSITIVE, SECRET}. The classifier
// is *key-shape-driven*: a key whose name matches a "secret-shaped"
// pattern (apiKey, api_key, password, secret, token, cookie, …) is
// always SECRET regardless of the supplied value.
//
// classifyFields is pure: it returns a parallel structure with the same
// shape as the input but leaves replaced by classification strings. It
// is the building block used by the redactor (which substitutes SECRET
// values for '__REDACTED__') and the exporter (which redacts SECRET
// values before serializing to NDJSON).

import type { DataClassification } from './state-machine.js';

export type ClassifiedValue =
  | DataClassification
  | { [key: string]: ClassifiedValue }
  | ClassifiedValue[];

const SECRET_KEY_PATTERN = /(secret|password|token|apikey|api_key|cookie|authorization)/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

export function classifyValue(key: string): DataClassification {
  if (isSecretKey(key)) return 'SECRET';
  return 'PUBLIC';
}

export function classifyFields(input: unknown): ClassifiedValue {
  if (Array.isArray(input)) {
    return input.map((item) => classifyFields(item));
  }
  if (!isPlainObject(input)) {
    // Primitives (string/number/boolean/null) at the root are PUBLIC.
    return 'PUBLIC';
  }
  const out: Record<string, ClassifiedValue> = {};
  for (const [key, value] of Object.entries(input)) {
    if (isPlainObject(value) || Array.isArray(value)) {
      out[key] = classifyFields(value);
    } else {
      out[key] = classifyValue(key);
    }
  }
  return out;
}
