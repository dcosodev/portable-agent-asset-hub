import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: {
    '@portable-agent-asset-hub/core': new URL('./packages/core/src/index.ts', import.meta.url).pathname,
    '@portable-agent-asset-hub/storage-sqlite': new URL('./packages/storage-sqlite/src/index.ts', import.meta.url).pathname,
    '@portable-agent-asset-hub/storage-files': new URL('./packages/storage-files/src/index.ts', import.meta.url).pathname,
    // Subpath aliases MUST come before their parent alias so the more
    // specific match wins. Object key ordering is preserved in JS.
    '@portable-agent-asset-hub/materializers/hermes': new URL('./packages/materializers/src/hermes/index.ts', import.meta.url).pathname,
    '@portable-agent-asset-hub/materializers/openclaw': new URL('./packages/materializers/src/openclaw/index.ts', import.meta.url).pathname,
    '@portable-agent-asset-hub/materializers': new URL('./packages/materializers/src/index.ts', import.meta.url).pathname,
    '@portable-agent-asset-hub/rest': new URL('./packages/rest/src/index.ts', import.meta.url).pathname,
    '@portable-agent-asset-hub/sdk-ts': new URL('./packages/sdk-ts/src/index.ts', import.meta.url).pathname,
    '@portable-agent-asset-hub/mcp': new URL('./packages/mcp/src/index.ts', import.meta.url).pathname,
    '@portable-agent-asset-hub/migration': new URL('./packages/migration/src/index.ts', import.meta.url).pathname,
    '@portable-agent-asset-hub/runtime-adapters': new URL('./packages/runtime-adapters/src/index.ts', import.meta.url).pathname,
    '@portable-agent-asset-hub/skill-export': new URL('./packages/skill-export/src/index.ts', import.meta.url).pathname,
  } },
  test: { include: ['tests/**/*.test.ts'] },
});
