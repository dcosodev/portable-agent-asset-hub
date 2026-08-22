import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 's1-external-'));
try {
  const packages = (await readdir('dist-package')).filter((entry) => entry.endsWith('.tgz')).sort();
  if (packages.length !== 1) throw new Error(`EXPECTED_ONE_VERIFIED_PACKAGE:${packages.length}`);
  const packagePath = join(process.cwd(), 'dist-package', packages[0]);
  await run('npm', ['init', '-y'], { cwd: root });
  await run('npm', ['install', '--ignore-scripts', packagePath], { cwd: root });
  const result = await run(process.execPath, ['--input-type=module', '-e', "const m=await import('@portable-agent-asset-hub/spike-skills'); if(!m.SkillService||!m.createMcpServer) process.exit(2); console.log('external-import-ok')"], { cwd: root });
  console.log(result.stdout.trim());
  const bin = join(root, 'node_modules', '.bin', 'spike-skills-mcp');
  try {
    await run(bin, [], { cwd: root, env: { ...process.env, SPIKE_SKILLS_REST_URL: '' } });
    throw new Error('INSTALLED_BIN_UNEXPECTEDLY_SUCCEEDED');
  } catch (error) {
    if (error.message === 'INSTALLED_BIN_UNEXPECTEDLY_SUCCEEDED') throw error;
    const stderr = error.stderr ?? '';
    if (!stderr.includes('SPIKE_SKILLS_REST_URL is required')) throw new Error(`INSTALLED_BIN_NOT_EXECUTABLE_BY_NODE:${stderr}`, { cause: error });
  }
  console.log('external-bin-ok');
} finally {
  await rm(root, { recursive: true, force: true });
}
