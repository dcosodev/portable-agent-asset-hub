#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const composeFile = join(root, 'observability', 'compose.yaml');
const project = `hub-smoke-${process.pid}-${Date.now()}`.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
const token = randomBytes(24).toString('hex');
const artifactPath = join(root, 'artifacts', 'docker-stack-smoke.json');
const startedAt = new Date().toISOString();
const checks = [];
let failed = false;

// Ask Docker for ephemeral host ports so this isolated smoke can run while a
// persistent development stack owns the documented 39421/3000 defaults.
const env = {
  ...process.env,
  HUB_BEARER_TOKEN: token,
  HUB_REST_HOST_PORT: '0',
  GRAFANA_HOST_PORT: '0',
};
const composeArgs = ['compose', '-p', project, '-f', composeFile];
let hubBaseUrl;
let grafanaBaseUrl;

function run(command, args, { input, timeout = 300_000, allowFailure = false, commandEnv = env } = {}) {
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: root,
    env: commandEnv,
    input,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    timeout,
  });
  const value = {
    exitCode: result.status ?? 1,
    durationMs: Date.now() - started,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
  if (!allowFailure && value.exitCode !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${value.exitCode}): ${(value.stderr || value.stdout).slice(-3000)}`);
  }
  return value;
}

function compose(args, options) {
  return run('docker', [...composeArgs, ...args], options);
}

function record(name, status, evidence = {}) {
  checks.push({ name, ...evidence, status });
  if (status !== 'PASS') failed = true;
  console.log(`${status} ${name}`);
}

async function poll(name, operation, predicate, { timeoutMs = 180_000, intervalMs = 2_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (predicate(value)) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`${name} timed out${lastError ? `: ${String(lastError)}` : ''}`);
}

async function hubFetch(path, init = {}) {
  if (!hubBaseUrl) throw new Error('Hub published port has not been discovered');
  return globalThis.fetch(`${hubBaseUrl}${path}`, {
    ...init,
    headers: { authorization: ['Bearer', token].join(' '), ...(init.headers ?? {}) },
  });
}

function publishedBaseUrl(service, targetPort) {
  const output = compose(['port', service, String(targetPort)], { timeout: 30_000 }).stdout.trim();
  const match = output.match(/:(\d+)$/);
  if (!match) throw new Error(`unable to discover ${service}:${targetPort} published port from ${JSON.stringify(output)}`);
  return `http://127.0.0.1:${match[1]}`;
}

function internalGet(service, url) {
  const r = compose(['exec', '-T', service, 'wget', '-qO-', url], { timeout: 30_000 });
  return r.stdout;
}

function promQuery() {
  return JSON.parse(internalGet('prometheus', 'http://127.0.0.1:9090/api/v1/query?query=hub_requests_total'));
}

function tempoSearch() {
  return JSON.parse(internalGet('prometheus', 'http://tempo:3200/api/search?q=%7B%20name%20%3D%20%22hub.request%22%20%7D'));
}

function mcpSession(number) {
  const frames = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: `docker-smoke-${number}`, version: '1.0.0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ];
  const input = `${frames.map((frame) => JSON.stringify(frame)).join('\n')}\n`;
  const r = compose(['--profile', 'mcp', 'run', '--rm', '--no-deps', '-T', 'hub-mcp'], { input, timeout: 90_000 });
  const lines = r.stdout.trim().split(/\r?\n/).filter(Boolean);
  const output = lines.map((line) => JSON.parse(line));
  const tools = output.find((frame) => frame.id === 2)?.result?.tools;
  if (!output.some((frame) => frame.id === 1) || !Array.isArray(tools) || tools.length === 0) {
    throw new Error(`MCP session ${number} did not initialize/list tools`);
  }
  return { frames: output.length, tools: tools.length, stdoutJsonOnly: true, stderrBytes: Buffer.byteLength(r.stderr) };
}

try {
  const contractEnv = { ...env };
  delete contractEnv.HUB_REST_HOST_PORT;
  delete contractEnv.GRAFANA_HOST_PORT;
  const contract = run(process.execPath, [join(root, 'scripts', 'docker-stack-contract.mjs')], {
    timeout: 30_000,
    commandEnv: contractEnv,
  });
  const contractJson = JSON.parse(contract.stdout);
  record('contract', contractJson.status === 'PASS' ? 'PASS' : 'FAIL', { checked: contractJson.checked });

  const build = compose(['--profile', 'mcp', 'build', 'hub-rest', 'hub-mcp'], { timeout: 600_000 });
  record('images.build', 'PASS', { durationMs: build.durationMs });

  const inspect = run('docker', ['image', 'inspect', 'portable-agent-asset-hub/rest:dev', 'portable-agent-asset-hub/mcp:dev', '--format', '{{.Id}} {{.Architecture}} {{.Config.User}}']);
  const imageRows = inspect.stdout.trim().split(/\r?\n/);
  const imageOk = imageRows.length === 2 && imageRows.every((row) => row.includes(' arm64 ')) && imageRows.some((row) => row.endsWith(' hub')) && imageRows.some((row) => row.endsWith(' mcp'));
  record('images.arm64-nonroot', imageOk ? 'PASS' : 'FAIL', { images: imageRows });

  compose(['up', '-d', '--wait'], { timeout: 300_000 });
  hubBaseUrl = publishedBaseUrl('hub-rest', 39421);
  grafanaBaseUrl = publishedBaseUrl('grafana', 3000);
  record('stack.up', 'PASS');

  const health = await poll('Hub health', async () => {
    const response = await hubFetch('/api/v1/health');
    return { status: response.status, body: await response.json() };
  }, (value) => value.status === 200 && value.body?.ok === true, { timeoutMs: 60_000 });
  record('rest.health', 'PASS', { httpStatus: health.status, body: health.body });

  for (let i = 0; i < 12; i += 1) {
    const response = await hubFetch('/api/v1/health');
    if (!response.ok) throw new Error(`traffic request failed: ${response.status}`);
  }

  const prom = await poll('Prometheus series', async () => promQuery(), (value) => value?.data?.result?.length > 0, { timeoutMs: 60_000 });
  record('prometheus.nonempty', 'PASS', { series: prom.data.result.length });
  const forbiddenMetricLabels = new Set([
    'query', 'skill_id', 'session_id', 'request_id', 'resource_path', 'trace_id',
    'host_name', 'process_pid', 'process_command', 'process_command_args',
  ]);
  const leakedLabels = [...new Set(prom.data.result.flatMap((series) => Object.keys(series.metric).filter((key) => forbiddenMetricLabels.has(key))))].sort();
  record('prometheus.closed-labels', leakedLabels.length === 0 ? 'PASS' : 'FAIL', { leakedLabels });

  await poll('Tempo ready', async () => internalGet('prometheus', 'http://tempo:3200/ready'), (value) => value.trim() === 'ready');
  const tempo = await poll('Tempo traces', async () => tempoSearch(), (value) => value?.traces?.some((trace) => trace.rootTraceName === 'hub.request'));
  record('tempo.hub-request', 'PASS', { traces: tempo.traces.length });

  const grafanaHealthResponse = await globalThis.fetch(`${grafanaBaseUrl}/api/health`);
  const grafanaHealth = await grafanaHealthResponse.json();
  record('grafana.health', grafanaHealthResponse.ok && grafanaHealth.database === 'ok' ? 'PASS' : 'FAIL', { database: grafanaHealth.database });

  const datasources = await (await globalThis.fetch(`${grafanaBaseUrl}/api/datasources`)).json();
  const datasourceNames = Array.isArray(datasources) ? datasources.map((item) => item.uid).sort() : [];
  record('grafana.datasources', datasourceNames.includes('prometheus') && datasourceNames.includes('tempo') ? 'PASS' : 'FAIL', { datasourceUids: datasourceNames });

  const prometheusHealth = await (await globalThis.fetch(`${grafanaBaseUrl}/api/datasources/uid/prometheus/health`)).json();
  const tempoProxy = await globalThis.fetch(`${grafanaBaseUrl}/api/datasources/proxy/uid/tempo/ready`);
  const tempoProxyBody = await tempoProxy.text();
  record('grafana.datasource-health', prometheusHealth.status === 'OK' && tempoProxy.ok && tempoProxyBody.trim() === 'ready' ? 'PASS' : 'FAIL', { prometheus: prometheusHealth.status, tempo: tempoProxy.status });

  const dashboardResponse = await globalThis.fetch(`${grafanaBaseUrl}/api/search?type=dash-db`);
  const dashboards = await dashboardResponse.json();
  const dashboardUids = Array.isArray(dashboards) ? dashboards.map((item) => item.uid).sort() : [];
  record('grafana.dashboards', dashboardUids.length >= 4 ? 'PASS' : 'FAIL', { dashboardUids });

  const createResponse = await hubFetch('/api/v1/memories', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'fact', scopeKey: 'docker-smoke', content: { text: 'docker persistence canary' }, reason: 'docker stack persistence smoke', lifecycle: 'active' }),
  });
  if (createResponse.status !== 201) throw new Error(`memory create failed: ${createResponse.status} ${await createResponse.text()}`);
  const created = await createResponse.json();
  compose(['up', '-d', '--force-recreate', '--wait', 'hub-rest'], { timeout: 180_000 });
  hubBaseUrl = publishedBaseUrl('hub-rest', 39421);
  await poll('Recreated Hub health', async () => hubFetch('/api/v1/health'), (response) => response.ok, { timeoutMs: 60_000 });
  const persistedResponse = await hubFetch(`/api/v1/memories/${encodeURIComponent(created.id)}`);
  const persisted = await persistedResponse.json();
  record('sqlite.persistence', persistedResponse.ok && persisted.id === created.id && persisted.content?.text === 'docker persistence canary' ? 'PASS' : 'FAIL', { memoryId: created.id, version: persisted.version });

  const firstMcp = mcpSession(1);
  const secondMcp = mcpSession(2);
  record('mcp.two-sequential-sessions', firstMcp.stdoutJsonOnly && secondMcp.stdoutJsonOnly ? 'PASS' : 'FAIL', { sessions: [firstMcp, secondMcp] });

  compose(['stop', 'otel-collector'], { timeout: 60_000 });
  let downRequestsOk = true;
  for (let i = 0; i < 5; i += 1) {
    const response = await hubFetch('/api/v1/health');
    downRequestsOk &&= response.ok;
  }
  const restContainer = compose(['ps', '-q', 'hub-rest']).stdout.trim();
  const restState = run('docker', ['inspect', restContainer, '--format', '{{.State.Status}}/{{.State.Health.Status}}']).stdout.trim();
  record('collector-down.fail-open', downRequestsOk && restState === 'running/healthy' ? 'PASS' : 'FAIL', { restState });

  compose(['start', 'otel-collector'], { timeout: 60_000 });
  for (let i = 0; i < 5; i += 1) await hubFetch('/api/v1/health');
  const recoveredProm = await poll('Prometheus recovery', async () => promQuery(), (value) => value?.data?.result?.length > 0, { timeoutMs: 60_000 });
  const recoveredTempo = await poll('Tempo recovery', async () => tempoSearch(), (value) => value?.traces?.length > 0, { timeoutMs: 60_000 });
  record('collector.recovery', 'PASS', { promSeries: recoveredProm.data.result.length, tempoTraces: recoveredTempo.traces.length });
} catch (error) {
  failed = true;
  record('unhandled', 'FAIL', { error: error instanceof Error ? error.message : String(error) });
} finally {
  const cleanup = compose(['down', '-v', '--remove-orphans'], { timeout: 180_000, allowFailure: true });
  record('cleanup.down-v', cleanup.exitCode === 0 ? 'PASS' : 'FAIL', { exitCode: cleanup.exitCode });
  const artifact = {
    gate: 'docker-stack-smoke',
    status: failed ? 'FAIL' : 'PASS',
    project,
    startedAt,
    finishedAt: new Date().toISOString(),
    checks,
  };
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`artifact ${artifactPath}`);
  if (failed) process.exitCode = 1;
}
