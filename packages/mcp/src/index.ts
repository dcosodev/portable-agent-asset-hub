// packages/mcp/src/index.ts
//
// Public surface of the @portable-agent-asset-hub/mcp package. The MCP
// server is a thin facade over REST: it never opens a database, never
// reads from disk, and never has a "local mode" fallback. If the
// configured REST base URL is unreachable the server starts anyway and
// every call fails with a structured transport error.

export * from './types.js';
export * from './identity.js';
export * from './capabilities.js';
export * from './error-mapper.js';
export * from './rest-transport.js';
export * from './tool-invoker.js';
export {
  buildToolRegistry,
  expectedToolOperationIds,
  toolNameForOperation,
  GENERATED_TOOLS,
} from './tool-registry.js';
export * from './server.js';
export { GENERATED_METADATA } from './generated-tool-metadata.js';
