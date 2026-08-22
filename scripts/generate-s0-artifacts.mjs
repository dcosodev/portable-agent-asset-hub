import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const python = process.env.AGENT_MEMORY_ROOT ?? 'examples/agent-memory';
const baseline = process.env.BASELINE_ROOT ?? 'artifacts/s0-baseline';
const snapshot = join(baseline, 'agent-memory-python-s0.tar.gz');
const rejected = join(baseline, 'rejected', 's0-original-rejected-exclusions');
const exclusions = ['.git', '.venv', '.pytest_cache', '.ruff_cache', '__pycache__', 'dist', 'build', 'caches', 'logs', 'secrets'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const atomicWrite = async (path, text) => { const temp = `${path}.tmp-${process.pid}`; await writeFile(temp, text); await rename(temp, path); };
await mkdir(rejected, { recursive: true });
for (const p of [snapshot, `${snapshot}.sha256`]) {
  try {
    await stat(p);
    const suffix = p.endsWith('.sha256') ? `replaced-${process.pid}.tar.gz.sha256` : `replaced-${process.pid}.tar.gz`;
    await rename(p, join(rejected, suffix));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}
await atomicWrite(join(rejected, 'REASON.txt'), 'Preserved S0 artifact rejected because the archive contained .git and excluded cache/bytecode entries. Replaced atomically by a clean archive.\n');
const temp = `${snapshot}.tmp-${process.pid}`;
const code = `import os, tarfile, pathlib, sys\nsrc=pathlib.Path(sys.argv[1]); out=sys.argv[2]; excluded=set(${JSON.stringify(exclusions)})\nwith tarfile.open(out, 'w:gz') as tf:\n  for root, dirs, files in os.walk(src, topdown=True, followlinks=False):\n    rel=pathlib.Path(root).relative_to(src)\n    dirs[:]=sorted(d for d in dirs if d not in excluded and not pathlib.Path(root,d).is_symlink())\n    files[:]=sorted(f for f in files if f not in excluded and not f.endswith('.pyc') and not f.endswith('.egg-info') and not pathlib.Path(root,f).is_symlink())\n    for name in dirs+files:\n      p=pathlib.Path(root,name); arc=pathlib.PurePosixPath('agent-memory', p.relative_to(src).as_posix()); tf.add(p, arcname=str(arc), recursive=False)\n`;
execFileSync('python3', ['-c', code, python, temp], { stdio: 'inherit' });
await rename(temp, snapshot);
const hash = digest(await readFile(snapshot));
await atomicWrite(`${snapshot}.sha256`, `${hash}  ${snapshot}\n`);
console.log(JSON.stringify({ snapshot, sha256: hash, rejected, exclusions }));
