/* global console */
import { validateBaselineArchiveEntries } from '../dist/packages/baseline/index.js';

const cases = [
  ['.env', 'file'], ['node_modules/pkg/index.js', 'file'], ['coverage.txt', 'file'],
  ['src/bad.pyc', 'file'], ['agent-memory/link', 'symlink'], ['agent-memory/hard', 'hardlink'],
  ['agent-memory/agent-memory/nested.txt', 'file'], ['outside/file.txt', 'file'], ['/agent-memory/absolute', 'file'],
  ['agent-memory/../outside', 'file'], ['agent-memory/a\\b', 'file'], ['agent-memory/a\0b', 'file'],
];
for (const [path, type] of cases) {
  const archivePath = path === 'outside/file.txt' || path.startsWith('agent-memory/') || path.startsWith('/') ? path : `agent-memory/${path}`;
  const errors = validateBaselineArchiveEntries([{ path: archivePath, type }]);
  if (errors.length === 0) throw new Error(`archive entry was accepted: ${path} (${type})`);
}
const duplicateErrors = validateBaselineArchiveEntries([
  { path: 'agent-memory/x', type: 'file' },
  { path: 'agent-memory/x/', type: 'directory' },
]);
if (!duplicateErrors.some(error => error.includes('duplicate'))) {
  throw new Error('post-canonicalization archive duplicate was accepted');
}
console.log(JSON.stringify({ rejected: cases.length + 1, policy: 'DEFAULT_EXCLUSIONS' }));
