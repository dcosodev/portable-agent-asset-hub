// Compiles the hub binary once before any test worker starts. The tests/go
// suites build it lazily in each worker, so on a cold cache the workers compete
// and the first test in a file can exceed its timeout. With the cache warm, each
// of those builds is quick.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default function warmGoBuildCache(): void {
  const dir = mkdtempSync(join(tmpdir(), 'hub-go-cache-'));
  try {
    // -trimpath changes the cache key, and the harnesses build both ways.
    for (const flags of [['-trimpath'], []]) {
      spawnSync('go', ['build', ...flags, '-o', join(dir, 'hub'), './cmd/hub'], {
        stdio: 'ignore',
      });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
