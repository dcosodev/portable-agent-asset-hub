// tests/go/shell/help.test.ts
//
// T1 real-subprocess contract for `hub --help` / `hub help` /
// `hub` (no argv). The tests build a temp hub binary with
// `go build -trimpath` (via _hub-harness) and assert on the LIVE
// subprocess output. The contract surface locked in here:
//
//   * default invocation (no argv)            → exit 0, prints help.
//   * `hub --help`                            → exit 0, prints help.
//   * `hub -h`                                → exit 0, prints help.
//   * `hub help`                              → exit 0, prints help.
//   * stderr empty on the help path           → diagnostics belong on
//                                              stderr ONLY when the
//                                              command failed.
//   * the help block contains the documented
//     sections (Usage / Environment / Exit)    → no silent contract
//                                              regression.
//   * no bearer-shaped string in either
//     stream                                  → the help text never
//                                              trips the redactor.

import { describe, expect, it } from 'vitest';
import { runHub } from './_hub-harness';

// Bearer-shape predicates for the inline `not.toMatch` assertions.
// Mirrors `_hub-harness.ts` and `internal/output/output.go`. JS
// regex literals do NOT support inline flags like `(?i)` — that is
// PCRE/Python/Ruby syntax — so we use the `i` flag on the RegExp
// literal here. Promoted to module scope to avoid recompiling on
// every assertion and to make the intent self-documenting.
const BEARER_PREFIXED_OPAQUE = /bearer\s+[A-Za-z0-9._~+/=-]{20,}/i;
const HUB_BEARER_ENV_ASSIGNMENT = /\bHUB_BEARER_TOKEN\b\s*=/i;
const JWT_TRIPLE_SEGMENT = /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/;

const HELP_SECTION_ANCHORS = [
  'hub — portable-agent-asset-hub product shell',
  'Usage:',
  'hub --version',
  'hub version',
  'hub version --json',
  'hub path <KEY>',
  'hub config <KEY>',
  'hub config --json',
  'hub doctor',
  'hub doctor --json',
  'Environment:',
  'HUB_HOME',
  'HUB_RUNTIME',
  'HUB_OPENAPI',
  'Exit codes:',
  '0  success',
  '1  operator error',
  '2  contract violation',
];

describe('hub help — invocation surfaces', () => {
  it('default_no_argv_prints_help_and_exits_zero', async () => {
    const res = await runHub([]);
    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
    for (const anchor of HELP_SECTION_ANCHORS) {
      expect(res.stdout).toContain(anchor);
    }
  }, 30_000);

  it('--help_prints_help_and_exits_zero', async () => {
    const res = await runHub(['--help']);
    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
    for (const anchor of HELP_SECTION_ANCHORS) {
      expect(res.stdout).toContain(anchor);
    }
  }, 30_000);

  it('-h_short_form_prints_help_and_exits_zero', async () => {
    const res = await runHub(['-h']);
    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
    expect(res.stdout).toContain('Usage:');
    expect(res.stdout).toContain('Exit codes:');
  }, 30_000);

  it('help_subcommand_prints_help_and_exits_zero', async () => {
    const res = await runHub(['help']);
    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
    expect(res.stdout).toContain('Usage:');
  }, 30_000);

  it('all_three_invocation_forms_produce_byte_exact_stdout', async () => {
    // The three "help" surfaces must produce the same stdout so a
    // CI pipeline can rely on a single diff-anchor for the block.
    const noArg = await runHub([]);
    const dashHelp = await runHub(['--help']);
    const help = await runHub(['help']);
    expect(noArg.status).toBe(0);
    expect(dashHelp.status).toBe(0);
    expect(help.status).toBe(0);
    expect(dashHelp.stdout).toBe(noArg.stdout);
    expect(help.stdout).toBe(noArg.stdout);
  }, 30_000);
});

describe('hub help — bearer hygiene', () => {
  it('help_stdout_contains_no_bearer_shaped_string', async () => {
    const res = await runHub(['--help']);
    expect(res.status).toBe(0);
    expect(res.stdout).not.toMatch(BEARER_PREFIXED_OPAQUE);
    expect(res.stdout).not.toMatch(HUB_BEARER_ENV_ASSIGNMENT);
    expect(res.stdout).not.toMatch(JWT_TRIPLE_SEGMENT);
  }, 30_000);

  it('help_stderr_contains_no_bearer_shaped_string', async () => {
    const res = await runHub(['--help']);
    expect(res.status).toBe(0);
    expect(res.stderr).not.toMatch(BEARER_PREFIXED_OPAQUE);
    expect(res.stderr).not.toMatch(HUB_BEARER_ENV_ASSIGNMENT);
    expect(res.stderr).not.toMatch(JWT_TRIPLE_SEGMENT);
  }, 30_000);
});

describe('hub help — failure paths are deterministic', () => {
  it('unknown_command_returns_exit_two_with_help_pointer', async () => {
    const res = await runHub(['definitely-not-a-command']);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/unknown command/);
    expect(res.stderr).toMatch(/--help/);
  }, 30_000);

  it('repeated_help_invocations_have_identical_stdout', async () => {
    const a = await runHub(['--help']);
    const b = await runHub(['--help']);
    expect(a.status).toBe(0);
    expect(b.status).toBe(0);
    expect(a.stdout).toBe(b.stdout);
  }, 30_000);
});
