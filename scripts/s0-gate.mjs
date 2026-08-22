import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const cwd = new URL('..', import.meta.url).pathname;
const steps = [
  ['lint', ['lint']],
  ['typecheck', ['typecheck']],
  ['test', ['test']],
  ['package-security-probe', [process.execPath, ['tests/package-security-probe.mjs']]],
  ['build', ['build']],
  ['tar-security-probe', [process.execPath, ['tests/s0-tar-security-probe.mjs']]],
  ['isolated-manifest-probe', [process.execPath, ['tests/s0-isolation-probe.mjs']]],
  ['audit', ['audit', '--prod']],
  ['baseline:audit', ['baseline:audit']],
  ['package-check-1', [process.execPath, ['scripts/s0-package-check.mjs']]],
  ['package-check-2', [process.execPath, ['scripts/s0-package-check.mjs']]],
  ['pack', ['pack']],
];
for (const [name, command] of steps) {
  const [file, args] = command[0] === process.execPath ? command : ['pnpm', command];
  process.stdout.write(`\n==> ${name}\n`);
  const result = await exec(file, args, { cwd, env: { ...process.env, CI: 'true' }, maxBuffer: 50 * 1024 * 1024 });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr);
}
console.log(JSON.stringify({ gate: 's0', steps: steps.map(([name]) => name), passed: true }));
