import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join } from 'node:path';
const exec = promisify(execFile);
const cwd = new URL('..', import.meta.url).pathname;
await rm(join(cwd, 'artifacts'), { recursive: true, force: true });
await mkdir(join(cwd, 'artifacts'));
await exec('pnpm', ['pack', '--pack-destination', 'artifacts'], { cwd, env: { ...process.env, CI: 'true' }, maxBuffer: 10 * 1024 * 1024 });
