#!/usr/bin/env node
/* global process */
// tests/go/runtime/fake-docker.mjs — hermetic docker shim for T2 tests.
// See tests/go/runtime/_runtime-harness.ts for the contract.
//
// This script is launched by a tiny shell wrapper that resolves
// `docker` on the subprocess PATH. The script records every
// invocation (argv + key env) into a JSONL transcript and emits
// canned, deterministic responses based on argv[3] (the compose
// subcommand). It NEVER shells out, never touches the network,
// never reads the real compose file.
//
// Lint env: ESLint flat config does NOT honour `/* eslint-env node */`
// comments (they emit a warning today and will hard-error in v10).
// Instead, `eslint.config.js` applies the `nodeGlobals` profile
// (process / console / Buffer / URL / setTimeout / clearTimeout)
// to `tests/go/runtime/fake-docker.mjs` so `no-undef` resolves
// the Node globals this shim relies on.
'use strict';
import { appendFileSync, readFileSync, existsSync } from 'node:fs';

const logPath = process.env.FAKE_DOCKER_LOG || '';
const exitCode = parseInt(process.env.FAKE_DOCKER_EXIT || '0', 10);
const psJsonPath = process.env.FAKE_DOCKER_PS_JSON || '';
const psAllJsonPath = process.env.FAKE_DOCKER_PS_ALL_JSON || '';
const stdoutAppendPath = process.env.FAKE_DOCKER_STDOUT_APPEND || '';
const stderrAppendPath = process.env.FAKE_DOCKER_STDERR_APPEND || '';

function readIfExists(p) {
  try {
    if (p && existsSync(p)) return readFileSync(p, 'utf8');
  } catch {
    // best-effort — the optional catch binding (ES2019) avoids
    // declaring `_err` only to discard it, which trips
    // `@typescript-eslint/no-unused-vars`.
  }
  return '';
}

// Record env keys we care about. The Go runtime strips
// HUB_BEARER_TOKEN* from the subprocess env, so a healthy test
// sees empty strings here. Any non-empty value = regression.
const envSnapshot = {
  HUB_BEARER_TOKEN: process.env.HUB_BEARER_TOKEN || '',
  HUB_BEARER_TOKEN_FILE: process.env.HUB_BEARER_TOKEN_FILE || '',
  HUB_BEARER_TOKEN_SOURCE: process.env.HUB_BEARER_TOKEN_SOURCE || '',
  AGENT_MEMORY_BEARER_TOKEN: process.env.AGENT_MEMORY_BEARER_TOKEN || '',
  HUB_BEARER_TOKEN_FILE_FORWARDED: process.env.HUB_BEARER_TOKEN_FILE_FORWARDED || '',
};

const record = {
  ts: new Date().toISOString(),
  argv: process.argv.slice(2),
  env_bearers: envSnapshot,
  cwd: process.cwd(),
};

if (logPath) {
  try {
    appendFileSync(logPath, JSON.stringify(record) + '\n', 'utf8');
  } catch {
    // best-effort — see `readIfExists` above; mirror the optional
    // catch binding so this file is uniformly lint-clean.
  }
}

// Replay any pre-recorded stdout/stderr before we emit our own.
// Tests use this to simulate compose errors / partial outputs.
if (stdoutAppendPath) {
  const payload = readIfExists(stdoutAppendPath);
  if (payload) process.stdout.write(payload);
}
if (stderrAppendPath) {
  const payload = readIfExists(stderrAppendPath);
  if (payload) process.stderr.write(payload);
}

// Dispatch on the compose subcommand. process.argv layout for
// the wrapper `exec node docker.mjs "$@"`:
//   argv[0] = node
//   argv[1] = docker.mjs
//   argv[2..] = the docker argv (e.g. 'compose', '-p', 'hub-…',
//                '-f', '…/compose.yaml', 'up', '--wait').
//
// The Go runtime forwards `compose -p <project> -f <yaml> <verb>
// [opts…]` so the verb sits AFTER the optional flags. We scan
// argv[2..] for the FIRST token that names a known compose verb;
// any preceding tokens are treated as options. This is robust
// against future re-orderings (`-f` before `-p`, additional flags,
// etc.) without breaking the existing up/down/ps/logs surface.
//
// Top-level docker subcommands (`context`, `contexts`, `version`)
// are also accepted because the harness may probe them through a
// future Detect path — they short-circuit the verb scan and reply
// directly.
const KNOWN_COMPOSE_VERBS = new Set([
  'up',
  'down',
  'ps',
  'logs',
  'restart',
  'kill',
  'config',
  'pull',
  'build',
  'stop',
  'start',
  'exec',
  'run',
  'ls',
]);

function locateComposeVerb(argv) {
  // argv is process.argv.slice(2) — the docker argv.
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === 'compose') {
      // The verb is the FIRST token AFTER `compose` that does not
      // look like an option flag or a flag value. We scan forward
      // and skip any token starting with `-` plus its value (the
      // value for `-p` / `-f` is the very next token).
      for (let j = i + 1; j < argv.length; j += 1) {
        const t = argv[j];
        if (t.startsWith('-')) {
          // Skip the value for short flags that take a value.
          // We treat `-p`, `-f`, `--project`, `--file` as value
          // flags. This is enough for the T2 surface; a future
          // flag that takes a value would need an explicit
          // addition here.
          if (t === '-p' || t === '-f' || t === '--project' || t === '--file') {
            j += 1;
          }
          continue;
        }
        if (KNOWN_COMPOSE_VERBS.has(t)) {
          return t;
        }
        // Unknown non-option token: not a recognised verb.
        // Continue scanning so a future refactor that injects a
        // positional before the verb still finds the verb.
      }
      return '';
    }
    // Top-level docker subcommands (no compose prefix).
    if (tok === 'context' || tok === 'contexts' || tok === 'version') {
      return tok;
    }
  }
  return '';
}

const composeVerb = locateComposeVerb(process.argv.slice(2));
const subcommand = composeVerb;
const hasAll = process.argv.includes('--all');

if (composeVerb === 'up') {
  // Minimal Compose-compatible output. We keep stdout silent and
  // exit cleanly. Tests that want to simulate a compose failure
  // use FAKE_DOCKER_STDERR_APPEND + FAKE_DOCKER_EXIT.
  process.exit(Number.isNaN(exitCode) ? 0 : exitCode);
}
if (composeVerb === 'down') {
  // Compose writes "Removing volume <name>" lines for each removed
  // volume. The default down (no -v) emits no volume lines. The
  // fake honours FAKE_DOCKER_DOWN_VOLUMES_FILE (one volume name
  // per line) so a test that wants to simulate a down -v (and
  // prove hub-data does NOT appear) can inject them.
  const volsPath = process.env.FAKE_DOCKER_DOWN_VOLUMES_FILE || '';
  if (volsPath) {
    const v = readIfExists(volsPath);
    for (const line of v.split('\n')) {
      const t = line.trim();
      if (t) process.stdout.write('Removing volume ' + t + '\n');
    }
  }
  process.exit(Number.isNaN(exitCode) ? 0 : exitCode);
}
if (composeVerb === 'ps') {
  // Return the canned ps JSON. The test supplies it via env so the
  // ps surface is fully under the test's control.
  const jsonPath = hasAll && psAllJsonPath ? psAllJsonPath : psJsonPath;
  if (jsonPath) {
    const payload = readIfExists(jsonPath);
    if (payload) process.stdout.write(payload);
  }
  // Some Compose versions expect JSON on a single line; we honour
  // whatever the test wrote. Exit cleanly.
  process.exit(Number.isNaN(exitCode) ? 0 : exitCode);
}
if (composeVerb === 'logs') {
  // Emit FAKE_DOCKER_LOGS_FILE content (Compose's --no-color output).
  const logsPath = process.env.FAKE_DOCKER_LOGS_FILE || '';
  if (logsPath) {
    const payload = readIfExists(logsPath);
    if (payload) process.stdout.write(payload);
  }
  process.exit(Number.isNaN(exitCode) ? 0 : exitCode);
}
if (subcommand === 'version') {
  process.stdout.write('fake-docker 0.0.0 (compose shim)\n');
  process.exit(0);
}
if (subcommand === 'context' || subcommand === 'contexts') {
  // Used by Detect via ContextInspectRaw probe; the Go runtime
  // does not actually shell out for context today, but if a future
  // change does, the shim still has a sane response.
  process.stdout.write('[]\n');
  process.exit(0);
}
// Unknown subcommand — be loud so a regression is obvious.
process.stderr.write('fake-docker: unknown compose subcommand ' + JSON.stringify(subcommand) + '\n');
process.exit(2);
