const sensitiveKeys = new Set([
  'password',
  'passwd',
  'token',
  'accesstoken',
  'refreshtoken',
  'secret',
  'apikey',
  'api_key',
  'authorization',
  'privatekey',
]);

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
      if (key && sensitiveKeys.has(key.toLowerCase())) {
        summary.add(key.toLowerCase().replaceAll('_', ''));
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
