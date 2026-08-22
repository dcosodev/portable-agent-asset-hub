import { mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writePending, writeEvidence } from './gate-state.mjs';
const run = promisify(execFile); const evidencePath = 'artifacts/s1-evidence.json'; const decisionPath = 'go-no-go.md';
const steps = [['lint', ['lint']], ['typecheck', ['typecheck']], ['test', ['test']], ['build', ['build']], ['package', ['package']], ['external-install', ['external-install']], ['protocol-smoke', ['protocol-smoke']], ['stdio-smoke', ['stdio-smoke']], ['no-cloud', ['no-cloud']], ['metrics', ['metrics']], ['regression-s0', ['--dir', '../..', 's0:gate']]];
await mkdir('artifacts', { recursive: true }); await writePending(evidencePath, decisionPath, steps);
const results = {};
for (const [name, args] of steps) { const started = new Date().toISOString(); try { const result = name === 'metrics' ? await run(process.execPath, ['scripts/metrics.mjs'], { env: { ...process.env, CI: 'true' }, maxBuffer: 20 * 1024 * 1024 }) : await run('pnpm', args, { env: { ...process.env, CI: 'true' }, maxBuffer: 20 * 1024 * 1024 }); results[name] = { status: 'PASS', started, exitCode: 0, stdout: result.stdout.slice(-4000), stderr: result.stderr.slice(-4000) }; } catch (error) { results[name] = { status: 'FAIL', started, exitCode: error.code ?? 1, stdout: error.stdout?.slice(-4000) ?? '', stderr: error.stderr?.slice(-4000) ?? String(error) }; } await writeEvidence(evidencePath, { status: 'RUNNING', complete: false, steps: results }); }
const complete = Object.keys(results).length === steps.length && Object.values(results).every((result) => result.status === 'PASS');
const evidence = { status: complete ? 'PASS' : 'FAIL', complete, steps: results, decision: complete ? { direct_tencent_code_extraction: 'NO-GO', proceed_to_s2_clean_room_contract_informed: 'GO', primary: 'GO_WITH_PIVOT' } : { direct_tencent_code_extraction: 'NO-GO', proceed_to_s2_clean_room_contract_informed: 'NO-GO', primary: 'NO-GO' } };
await writeEvidence(evidencePath, evidence);
await (await import('node:fs/promises')).writeFile(decisionPath, `# S1 Go/No-Go\n\nDecision: **${evidence.decision.primary}**\n\nFunctional gate: **${complete ? 'PASS' : 'NO-GO'}**\n\n- direct_tencent_code_extraction: **${evidence.decision.direct_tencent_code_extraction}**\n- proceed_to_s2_clean_room_contract_informed: **${evidence.decision.proceed_to_s2_clean_room_contract_informed}**\n\nEvidence: artifacts/s1-evidence.json\n\nFail-closed: NO-GO is written before execution and can change only after every required step is PASS.\n`);
if (!complete) process.exitCode = 1;
