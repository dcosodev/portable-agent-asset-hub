import { writeFile } from 'node:fs/promises';
export async function writePending(evidencePath, decisionPath, steps) { const pending = { status: 'PENDING', complete: false, steps: Object.fromEntries(steps.map(([name]) => [name, { status: 'PENDING' }])) }; await writeFile(evidencePath, JSON.stringify(pending, null, 2) + '\n'); await writeFile(decisionPath, '# S1 Go/No-Go\n\nDecision: **NO-GO**\n\nEvidence is pending; fail-closed before execution.\n'); }
export async function writeEvidence(path, evidence) { await writeFile(path, JSON.stringify(evidence, null, 2) + '\n'); }
