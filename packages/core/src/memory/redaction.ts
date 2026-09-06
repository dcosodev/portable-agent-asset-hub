// Compared against a NORMALIZED field key (lowercased, `_`/`-`
// stripped — see `normalizeKey`) rather than the raw key, so
// 'access_token', 'accessToken' and 'access-token' all match the same
// 'accesstoken' entry below instead of requiring every real-world
// spelling to be listed separately.
const sensitiveKeys = new Set([
  'password',
  'passwd',
  'token',
  'accesstoken',
  'refreshtoken',
  'secret',
  'clientsecret',
  'apikey',
  'authorization',
  'privatekey',
]);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/gu, '');
}

const patterns: Array<[string, RegExp]> = [
  ['bearer', /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi],
  ['api_key', /\b(?:api[_-]?key|x-api-key)\s*[:=]\s*[^\s,;]+/gi],
  ['password', /\bpassword\s*[:=]\s*[^\s,;]+/gi],
  ['token', /\btoken\s*[:=]\s*[^\s,;]+/gi],
  ['secret', /\bsecret\s*[:=]\s*[^\s,;]+/gi],
  ['private_key', /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi],
  ['email', /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi],
];

export function redact(value: unknown): { value: unknown; summary: string[] } {
  const summary = new Set<string>();

  const walk = (current: unknown, key?: string): unknown => {
    if (typeof current === 'string') {
      if (key && sensitiveKeys.has(normalizeKey(key))) {
        summary.add(normalizeKey(key));
        return '[REDACTED:secret]';
      }
      let cleaned = current;
      for (const [name, pattern] of patterns) {
        pattern.lastIndex = 0;
        if (pattern.test(cleaned)) {
          summary.add(name);
          pattern.lastIndex = 0;
          cleaned = cleaned.replace(pattern, `[REDACTED:${name}]`);
        }
      }
      return cleaned;
    }
    if (Array.isArray(current)) return current.map((item) => walk(item, key));
    if (current && typeof current === 'object') {
      return Object.fromEntries(
        Object.entries(current).map(([entryKey, entryValue]) => [
          entryKey,
          walk(entryValue, entryKey),
        ]),
      );
    }
    return current;
  };

  return { value: walk(value), summary: [...summary].sort() };
}
