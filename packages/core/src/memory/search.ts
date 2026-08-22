import type { Scope } from '../identity/types.js';
import type { Memory } from './types.js';
export interface MemorySearchPort { search(scope: Scope, query: string, limit?: number): Memory[]; }
