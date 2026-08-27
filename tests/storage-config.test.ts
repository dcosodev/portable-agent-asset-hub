import { describe, expect, it } from 'vitest';
import { requireCanonicalStorage, resolveHubDatabasePath } from '@portable-agent-asset-hub/core';

describe('hub database resolution', () => {
  it('uses the explicit CLI path before environment and default paths', () => {
    const result = resolveHubDatabasePath({ cliPath: '/var/lib/hub.sqlite', env: { AGENT_MEMORY_DB_PATH: '/tmp/ignored.sqlite' }, homeDir: '/Users/tester', platform: 'darwin' });
    expect(result).toMatchObject({ path: '/var/lib/hub.sqlite', source: 'explicit-cli', mode: 'canonical', isTemporary: false });
  });
  it('uses explicit env paths and marks temp storage', () => {
    const result = resolveHubDatabasePath({ env: { AGENT_MEMORY_DB_PATH: '/tmp/e2e/hub.sqlite' }, homeDir: '/Users/tester', platform: 'darwin' });
    expect(result).toMatchObject({ path: '/tmp/e2e/hub.sqlite', source: 'explicit-env', mode: 'temporary', isTemporary: true });
  });
  it('uses the platform persistent default', () => {
    const result = resolveHubDatabasePath({ env: {}, homeDir: '/Users/tester', platform: 'darwin' });
    expect(result).toMatchObject({ path: '/Users/tester/Library/Application Support/portable-agent-asset-hub/hub.sqlite', source: 'default-persistent', mode: 'canonical', isTemporary: false });
  });
  it('rejects an explicit canonical mode on a temp path', () => {
    expect(() => resolveHubDatabasePath({ env: { AGENT_MEMORY_DB_PATH: '/tmp/hub.sqlite', AGENT_MEMORY_STORAGE_MODE: 'canonical' } })).toThrow(/canonical storage cannot use a temporary path/);
  });
  it('guards canonical writes on temporary storage', () => {
    const temp = resolveHubDatabasePath({ env: { AGENT_MEMORY_DB_PATH: '/tmp/hub.sqlite' } });
    expect(() => requireCanonicalStorage(temp)).toThrow('Canonical write refused: runtime is using temporary storage');
    const canonical = resolveHubDatabasePath({ env: {}, homeDir: '/Users/tester', platform: 'darwin' });
    expect(() => requireCanonicalStorage(canonical)).not.toThrow();
  });
});
