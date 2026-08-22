import { describe, expect, it } from 'vitest';
import { isPrivatePackageBytes } from '../scripts/package-private-policy.mjs';

describe('S0 package private-byte policy', () => {
  it.each([
    '<HOME>/private/token',
    '<HOME>/.hermes/config.yaml',
    '/tmp/private-secret.txt',
    'AWS_SECRET_ACCESS_KEY=real',
  ])('rejects real private bytes: %s', (value) => {
    expect(isPrivatePackageBytes(value)).toBe(true);
  });

  it.each(['<HOME>/example/project', '<LINUX_HOME>/project'])('accepts generic documentation examples: %s', (value) => {
    expect(isPrivatePackageBytes(value)).toBe(false);
  });
});
