#!/usr/bin/env node
// Static + rendered-Compose contract gate for the full Docker stack.
// Docker Compose itself is the YAML parser; this avoids maintaining an
// incomplete parser that can silently disagree with the runtime.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const paths = {
  dockerfile: join(root, 'Dockerfile'),
  dockerignore: join(root, '.dockerignore'),
  compose: join(root, 'observability', 'compose.yaml'),
  otel: join(root, 'observability', 'otel-collector.yaml'),
  tempo: join(root, 'observability', 'tempo.yaml'),
  prometheus: join(root, 'observability', 'prometheus.yaml'),
  datasources: join(root, 'observability', 'grafana', 'provisioning', 'datasources', 'datasources.yaml'),
};

const findings = [];
function check(name, ok, detail) {
  findings.push({ name, status: ok ? 'PASS' : 'FAIL', detail });
}
function read(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}
function env(service, key) {
  const value = service?.environment?.[key];
  return value === undefined || value === null ? undefined : String(value);
}
function mounts(service) {
  return Array.isArray(service?.volumes) ? service.volumes : [];
}
function publishedPorts(service) {
  return (service?.ports ?? []).map((p) => ({
    host: String(p.host_ip ?? ''),
    published: String(p.published ?? ''),
    target: Number(p.target),
  }));
}
function commandText(service) {
  return Array.isArray(service?.command) ? service.command.join(' ') : String(service?.command ?? '');
}

const dockerfile = read(paths.dockerfile);
const dockerignore = read(paths.dockerignore);
const composeSource = read(paths.compose);
const otel = read(paths.otel);
const tempo = read(paths.tempo);
const prometheus = read(paths.prometheus);
const datasources = read(paths.datasources);

check('dockerfile.present', dockerfile.length > 0, paths.dockerfile);
check('dockerfile.node22', /ARG NODE_IMAGE=node:22(?:\.\d+)*-[^\s]+/.test(dockerfile), 'pin a Node 22 base image');
check('dockerfile.pnpm', /ARG PNPM_VERSION=11\.0\.8/.test(dockerfile) && /corepack prepare pnpm@\$\{PNPM_VERSION\}/.test(dockerfile), 'pin pnpm 11.0.8 through Corepack');
check('dockerfile.frozen', /pnpm install[^\n]*--frozen-lockfile/.test(dockerfile), 'use frozen lockfile');
check('dockerfile.targets', /AS runtime-rest/.test(dockerfile) && /AS runtime-mcp/.test(dockerfile), 'define both runtime targets');
check('dockerfile.nonroot', /FROM[^\n]+AS runtime-rest[\s\S]*?USER hub/.test(dockerfile) && /FROM[^\n]+AS runtime-mcp[\s\S]*?USER mcp/.test(dockerfile), 'both runtimes must be non-root');
const builderSection = dockerfile.split(/FROM[^\n]+AS runtime-rest/)[0] ?? '';
check('dockerfile.builder-devdeps', !/ENV NODE_ENV=production/.test(builderSection), 'builder must not suppress devDependencies required by pnpm build');
check('dockerfile.no-missing-migrations-copy', !/^COPY migrations\//m.test(dockerfile) || existsSync(join(root, 'migrations')), 'do not COPY a nonexistent root migrations directory');
check('dockerfile.rest-command', dockerfile.includes('CMD ["node", "packages/rest/bin/agent-memory-rest.mjs"]'), 'REST runtime must launch the real bin');
check('dockerfile.mcp-command', dockerfile.includes('CMD ["node", "packages/mcp/bin/agent-memory-mcp.mjs"]'), 'MCP runtime must launch the real stdio bin');

const ignoreLines = dockerignore.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
for (const required of ['.git', 'node_modules', 'dist', 'artifacts']) {
  check(`dockerignore.${required}`, ignoreLines.includes(required), `must exclude ${required}`);
}
check('dockerignore.env', ignoreLines.includes('.env') && (ignoreLines.includes('.env.*') || ignoreLines.includes('.env*')), 'exclude all env files');
check('dockerignore.sqlite', ignoreLines.some((l) => l.includes('*.sqlite')) && ignoreLines.some((l) => l.includes('*.db')), 'exclude SQLite files');
check('dockerignore.backups', ignoreLines.some((l) => /backup/i.test(l)), 'exclude backups');

let rendered;
try {
  rendered = JSON.parse(execFileSync('docker', ['compose', '-f', paths.compose, '--profile', 'mcp', 'config', '--format', 'json'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  check('compose.parseable', true, 'docker compose config --format json');
} catch (error) {
  check('compose.parseable', false, String(error?.stderr ?? error?.message ?? error));
}

if (rendered) {
  const services = rendered.services ?? {};
  const required = ['hub-rest', 'hub-mcp', 'otel-collector', 'tempo', 'prometheus', 'grafana'];
  for (const name of required) check(`compose.service.${name}`, Boolean(services[name]), `missing ${name}`);
  check('compose.no-hermes', !Object.entries(services).some(([name, svc]) => name.toLowerCase().includes('hermes') || String(svc.image ?? '').toLowerCase().includes('hermes') || String(svc.container_name ?? '').toLowerCase().includes('hermes')), 'Hermes must not be a product service');
  check('compose.no-fixed-project-name', !/^name:/m.test(composeSource), 'allow isolated Compose project names');
  check('compose.no-container-name', !/\bcontainer_name:/m.test(composeSource), 'avoid cross-project container collisions');
  check('compose.no-fixed-network-name', !/^\s+name:\s*hub-/m.test(composeSource), 'avoid cross-project network collisions');

  const rest = services['hub-rest'] ?? {};
  const mcp = services['hub-mcp'] ?? {};
  check('hub-rest.host', env(rest, 'HOST') === '0.0.0.0', 'HOST=0.0.0.0');
  check('hub-rest.port', env(rest, 'PORT') === '39421', 'PORT=39421');
  check('hub-rest.db', env(rest, 'AGENT_MEMORY_DB_PATH') === '/data/hub.sqlite', 'DB=/data/hub.sqlite');
  check('hub-rest.otlp', env(rest, 'OTEL_EXPORTER_OTLP_ENDPOINT') === 'http://otel-collector:4318', 'internal OTLP DNS');
  check('hub-rest.volume', mounts(rest).some((v) => String(v.source) === 'hub-data' && String(v.target) === '/data'), 'hub-rest exclusively mounts hub-data');
  check('hub-mcp.rest-url', env(mcp, 'AGENT_MEMORY_REST_URL') === 'http://hub-rest:39421', 'MCP targets Hub REST');
  check('hub-mcp.memory-write-capability', env(mcp, 'AGENT_MEMORY_CAPABILITIES') === 'write.memory', 'expose only the bounded memory write surface in addition to implicit reads');
  check('hub-mcp.no-db', env(mcp, 'AGENT_MEMORY_DB_PATH') === undefined && !mounts(mcp).some((v) => String(v.target) === '/data' || String(v.source) === 'hub-data'), 'MCP must not own SQLite');
  check('hub-mcp.command', commandText(mcp).includes('agent-memory-mcp.mjs'), 'launch real MCP bin');

  const dbOwners = Object.entries(services).filter(([, svc]) => env(svc, 'AGENT_MEMORY_DB_PATH') !== undefined || mounts(svc).some((v) => String(v.source) === 'hub-data'));
  check('compose.single-db-owner', dbOwners.length === 1 && dbOwners[0][0] === 'hub-rest', `owners=${dbOwners.map(([n]) => n).join(',')}`);
  check('compose.no-host-network', !Object.values(services).some((s) => s.network_mode === 'host'), 'no host network');
  check('compose.no-privileged', !Object.values(services).some((s) => s.privileged === true), 'no privileged containers');
  check('compose.no-docker-socket', !composeSource.includes('/var/run/docker.sock'), 'no Docker socket');

  const allPorts = Object.entries(services).flatMap(([name, svc]) => publishedPorts(svc).map((p) => ({ name, ...p })));
  const expected = allPorts.filter((p) => (p.name === 'hub-rest' && p.published === '39421' && p.target === 39421) || (p.name === 'grafana' && p.published === '3000' && p.target === 3000));
  check('compose.default-ports-only', allPorts.length === 2 && expected.length === 2 && allPorts.every((p) => p.host === '127.0.0.1'), `ports=${JSON.stringify(allPorts)}`);
}

check('otel.receiver', /endpoint:\s*0\.0\.0\.0:4318/.test(otel), 'OTLP HTTP binds internally');
check('otel.tempo', /endpoint:\s*tempo:4317/.test(otel), 'Collector exports to Tempo DNS');
check('otel.prometheus', otel.includes('endpoint: 0.0.0.0:9464'), 'Prometheus exporter binds internally');
check('otel.no-resource-label-promotion', /resource_to_telemetry_conversion:[\s\S]{0,300}?enabled:\s*false/.test(otel), 'do not promote process/host resource attributes into metric labels');
check('otel.health', /endpoint:\s*0\.0\.0\.0:13133/.test(otel) && /extensions:\s*\[health_check\]/.test(otel), 'health extension enabled');
check('tempo.http', /http_listen_address:\s*0\.0\.0\.0/.test(tempo) && /http_listen_port:\s*3200/.test(tempo), 'Tempo HTTP internal bind');
check('tempo.grpc', /endpoint:\s*0\.0\.0\.0:4317/.test(tempo), 'Tempo OTLP gRPC internal bind');
check('prometheus.target', /otel-collector:9464/.test(prometheus), 'Prometheus uses Collector DNS');
check('grafana.tempo', /url:\s*http:\/\/tempo:3200/.test(datasources), 'Grafana uses Tempo DNS');
check('grafana.prometheus', /url:\s*http:\/\/prometheus:9090/.test(datasources), 'Grafana uses Prometheus DNS');

const failed = findings.filter((f) => f.status === 'FAIL');
const verdict = { status: failed.length ? 'FAIL' : 'PASS', checked: findings.length, failed: failed.length, findings };
process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
if (failed.length) process.exit(1);
