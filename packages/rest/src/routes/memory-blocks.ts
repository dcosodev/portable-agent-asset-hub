export const memoryBlockRoutes = [
  { method: 'GET', pattern: /^\/api\/v1\/memory-blocks$/, operationId: 'listMemoryBlocks', cas: false },
] as const;

export type MemoryBlockRoute = (typeof memoryBlockRoutes)[number];