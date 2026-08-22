import { homedir, tmpdir } from 'node:os';
import { resolve } from 'node:path';

const genericExamples = new Set(['<HOME>/example/project', '<LINUX_HOME>/project']);
const credentialNames = new Set(['AWS_SECRET_ACCESS_KEY', 'AWS_ACCESS_KEY_ID', 'PRIVATE_KEY', 'PASSWORD', 'TOKEN', 'API_KEY', 'CREDENTIAL']);

/** Return true only for bytes that identify a real private location or credential. */
export function isPrivatePackageBytes(value) {
  const text = String(value);
  const normalized = text.replaceAll('\\', '/');
  const analyzed = normalized.split(/\r?\n/).map(line => {
    let sanitized = line;
    for (const example of genericExamples) sanitized = sanitized.replaceAll(example, '');
    return sanitized;
  }).join('\n');
  const realHome = resolve(homedir()).replaceAll('\\', '/');
  const realTemp = resolve(tmpdir()).replaceAll('\\', '/');
  const privateRoots = [realHome, '/private' + realTemp, realTemp].filter(Boolean);
  if (privateRoots.some(root => analyzed.includes(`${root}/`) || analyzed === root)) return true;
  if (/(^|\/)(?:\.hermes|\.openclaw)(?:\/|$)/i.test(analyzed)) return true;
  if (/(^|\/)(?:private|secrets?|tokens?|cookies?|credentials?)(?:\/|[-_.]|$)/i.test(analyzed)) return true;
  for (const line of analyzed.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_-]*)\s*=/);
    const name = match?.[1] ?? '';
    if (credentialNames.has(name) || /(?:SECRET|TOKEN|PASSWORD|PRIVATE[_-]?KEY|CREDENTIAL)/i.test(name)) return true;
  }
  return false;
}
