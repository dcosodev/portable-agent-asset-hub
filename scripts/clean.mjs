import { lstat, realpath, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

const root = resolve(dirname(new URL(import.meta.url).pathname), '..');
const allowed = new Set(['dist', 'artifacts']);
const target = process.argv[2];
if (process.argv.length !== 3 || !allowed.has(target)) throw new Error('clean target must be the constant dist or artifacts');
const path = join(root, target);
const info = await lstat(path).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error));
if (info?.isSymbolicLink()) throw new Error('refusing to clean a symlink');
if (info) {
  const physicalRoot = await realpath(root); const physical = await realpath(path);
  const escaped = relative(physicalRoot, physical).startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || resolve(physicalRoot, relative(physicalRoot, physical)) !== physical;
  if (escaped || physical !== join(physicalRoot, target)) throw new Error('clean target escaped repository root');
}
await rm(path, { recursive: true, force: true });
