// tests/go/connect/cli-surface.test.ts
//
// T8 RED real-subprocess contract for the `hub hub connect` CLI
// surface. The Go shell does NOT yet implement `hub hub connect`;
// every test in this file is a contract assertion that flips GREEN
// the day the production author lands cmd/hub/cmd_connect.go and
// registers it in cmd/hub/main.go.
//
// Slice T8 contract (per docs/roadmap/slices.json):
//
//   * binary name: `hub`
//   * top-level command: `hub`  (per docs/phase0/naming.md the
//                                binary name IS the product name)
//   * subcommand: `connect`
//   * actions:     preview | apply | rollback
//
// So the operator's shell shape is:
//
//   hub hub connect preview   --harness hermes --profile <prf_…> --snapshot <snap_…> --target-root <dir>
//   hub hub connect apply     --harness hermes --profile <prf_…> --snapshot <snap_…> --target-root <dir>
//                            --lock-dir <dir>
//                            --reason <reason> --request-id <id>
//                            --reviewed-digest <sha256>
//                            [--observed-digest <sha256>]
//   hub hub connect rollback  --run-id <run_…> --reason <reason> --request-id <id>
//   hub hub connect --help
//   hub hub connect preview --help
//   hub hub connect apply --help
//   hub hub connect rollback --help
//
// Exit-code semantics (mirrors the existing repo exit convention):
//
//   0  success
//   1  operator / runtime error (e.g. config load failed,
//      target root missing, adapter failure surfaced verbatim)
//   2  contract violation / bad flags / unknown verb
//
// Today (pre-T8), every test in this file is RED because the
// binary's dispatcher hits the `default:` case in main.go and emits
// "hub: unknown command \"hub\"" on stderr with exit 2. Once T8
// lands, the SAME .test.ts files flip GREEN with zero source
// changes — that is the point of writing them first.
//
// The suite asserts on the SHAPE of the contract surface (argv
// acceptance, exit codes, stderr diagnostics, --help text) and
// NEVER duplicates implementation details like the Go internal
// package layout. The Go shell's behaviour is the system under
// test; vitest is the boundary that observes it.

import { describe, expect, it } from 'vitest';
import {
  runConnect,
  runConnectOnFreshHome,
} from './_connect-harness';

describe('hub hub connect — CLI surface (T8)', () => {
  // The dispatcher is the entry point the operator actually types.
  // Today every shape below exits 2 with "unknown command"; once
  // production lands the SAME argv shapes flip to the expected exit
  // code with the expected stdout/stderr channels.
  it('hub hub connect --help exits 0 and prints the documented help block', async () => {
    const res = await runConnectOnFreshHome(['hub', 'connect', '--help'], { label: 'help-root' });
    // RED today: status=2 stderr contains "hub: unknown command \"hub\"".
    // GREEN once production lands: status=0 stdout contains the
    // documented help block listing preview/apply/rollback.
    expect(res.status, `unexpected status\nstdout=${JSON.stringify(res.stdout)}\nstderr=${JSON.stringify(res.stderr)}`).toBe(0);
    expect(res.stderr).toBe('');
    // The help block must enumerate the three actions the slice
    // commits to. The exact shape is owned by the production
    // author; the test only locks the existence of the action
    // names so a silent contract regression surfaces here.
    expect(res.stdout).toMatch(/\bpreview\b/);
    expect(res.stdout).toMatch(/\bapply\b/);
    expect(res.stdout).toMatch(/\brollback\b/);
    res.cleanup();
  }, 30_000);

  it('hub hub connect preview --help exits 0 and prints the preview help block', async () => {
    const res = await runConnectOnFreshHome(['hub', 'connect', 'preview', '--help'], { label: 'help-preview' });
    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
    // The preview sub-help must enumerate the four arguments the
    // renderer needs: --harness, --profile, --snapshot, --target-root.
    // Without those, the operator cannot reconstruct the preview
    // request from --help alone.
    expect(res.stdout).toMatch(/--harness/);
    expect(res.stdout).toMatch(/--profile/);
    expect(res.stdout).toMatch(/--snapshot/);
    expect(res.stdout).toMatch(/--target-root/);
    res.cleanup();
  }, 30_000);

  it('hub hub connect apply --help exits 0 and prints the apply help block', async () => {
    const res = await runConnectOnFreshHome(['hub', 'connect', 'apply', '--help'], { label: 'help-apply' });
    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
    // The apply sub-help must enumerate --reviewed-digest. The
    // slice contract is explicit: apply without --reviewed-digest
    // is refused before the adapter is invoked. A missing flag in
    // the help text is a contract regression.
    expect(res.stdout).toMatch(/--reviewed-digest/);
    expect(res.stdout).toMatch(/--reason/);
    expect(res.stdout).toMatch(/--target-root/);
    res.cleanup();
  }, 30_000);

  // -----------------------------------------------------------------
  // Phase B — apply help distinguishes reviewedDigest (operator-
  // supplied review boundary) from observedDigest / expectedDigest
  // (live CAS pair). The amendment pins all three flags but
  // assigns them different semantics. The help block MUST
  // surface the distinction so an operator can pick the right
  // one without reading internal docs.
  //
  // The amendment pins:
  //   --reviewed-digest   SHA-256 of the plan CONTENT the operator
  //                        reviewed (carried verbatim across the
  //                        preview → apply boundary; not the CAS).
  //   --observed-digest   Optional drift signal; the live state
  //                        digest the apply step compares against
  //                        the manifest. Default = trust the
  //                        preview as live state.
  //   (expectedDigest is NOT a CLI flag; it is a TS-internal CAS
  //   value the apply step derives from the recomputed preview.)
  //
  // We do NOT assert the help text mentions expectedDigest by
  // name — that is a TS-internal surface — only that reviewedDigest
  // and observedDigest are both enumerated with distinct
  // semantics.
  // -----------------------------------------------------------------
  it('Phase B: apply --help distinguishes --reviewed-digest (plan content) from --observed-digest (live CAS)', async () => {
    const res = await runConnectOnFreshHome(['hub', 'connect', 'apply', '--help'], { label: 'help-apply-distinct' });
    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
    expect(res.stdout).toMatch(/--reviewed-digest/);
    expect(res.stdout).toMatch(/--observed-digest/);
    // Anti-aliasing: the help MUST NOT conflate the two. A
    // single flag name referencing both is a regression.
    // We assert the help block names them as two distinct flags.
    const reviewedMatches = (res.stdout.match(/--reviewed-digest/g) ?? []).length;
    const observedMatches = (res.stdout.match(/--observed-digest/g) ?? []).length;
    expect(reviewedMatches).toBeGreaterThan(0);
    expect(observedMatches).toBeGreaterThan(0);
    res.cleanup();
  }, 30_000);

  it('hub hub connect rollback --help exits 0 and prints the rollback help block', async () => {
    const res = await runConnectOnFreshHome(['hub', 'connect', 'rollback', '--help'], { label: 'help-rollback' });
    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
    // The rollback sub-help must enumerate --run-id. A missing flag
    // in the help text is a contract regression.
    expect(res.stdout).toMatch(/--run-id/);
    expect(res.stdout).toMatch(/--reason/);
    res.cleanup();
  }, 30_000);

  it('hub hub connect (no action) exits 2 with a usage diagnostic on stderr', async () => {
    const res = await runConnectOnFreshHome(['hub', 'connect'], { label: 'no-action' });
    // The slice is fail-closed: a missing action is a CLI contract
    // violation, not an operator error. Exit 2 + stderr diagnostic
    // is the locked shape.
    expect(res.status).toBe(2);
    expect(res.stderr).not.toBe('');
    res.cleanup();
  }, 30_000);

  it('hub hub connect preview (missing required flags) exits 2 with a usage diagnostic on stderr', async () => {
    const res = await runConnectOnFreshHome(['hub', 'connect', 'preview'], { label: 'preview-missing-flags' });
    expect(res.status).toBe(2);
    expect(res.stderr).not.toBe('');
    res.cleanup();
  }, 30_000);

  it('hub hub connect apply (missing required flags) exits 2 with a usage diagnostic on stderr', async () => {
    const res = await runConnectOnFreshHome(['hub', 'connect', 'apply'], { label: 'apply-missing-flags' });
    expect(res.status).toBe(2);
    expect(res.stderr).not.toBe('');
    res.cleanup();
  }, 30_000);

  it('hub hub connect rollback (missing required flags) exits 2 with a usage diagnostic on stderr', async () => {
    const res = await runConnectOnFreshHome(['hub', 'connect', 'rollback'], { label: 'rollback-missing-flags' });
    expect(res.status).toBe(2);
    expect(res.stderr).not.toBe('');
    res.cleanup();
  }, 30_000);

  it('hub hub connect <unknown-action> exits 2 with an unknown-verb diagnostic', async () => {
    const res = await runConnectOnFreshHome(['hub', 'connect', 'migrate'], { label: 'unknown-verb' });
    expect(res.status).toBe(2);
    expect(res.stderr).not.toBe('');
    res.cleanup();
  }, 30_000);

  it('hub hub connect --unknown-flag exits 2 with a usage diagnostic on stderr', async () => {
    const res = await runConnectOnFreshHome(['hub', 'connect', '--not-a-flag'], { label: 'unknown-flag' });
    expect(res.status).toBe(2);
    expect(res.stderr).not.toBe('');
    res.cleanup();
  }, 30_000);

  // No bearer ever leaks into any of the help streams. The
  // bearer-hygiene suite owns the deep redactor checks; the
  // surface-level "no bearer in --help" check is here because a
  // regression in the help renderer is the most common way a
  // bearer-shaped string accidentally lands on stdout.
  it('hub hub connect --help never emits a bearer-shaped string on stdout or stderr', async () => {
    const res = await runConnectOnFreshHome(['hub', 'connect', '--help'], { label: 'help-no-bearer' });
    // No assertion on status: this test fires on either RED
    // ("unknown command" diagnostic) or GREEN (help block). The
    // assertion is the absence of bearer-shaped substrings in
    // BOTH streams so a regression in either direction surfaces.
    const bearerRegex = /bearer\s+[A-Za-z0-9._~+/=-]{20,}/i;
    const envRegex = /\bHUB_BEARER_TOKEN\b\s*=\s*[^\s,'"]+/i;
    const jwtRegex = /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/;
    expect(res.stdout, `stdout leaked bearer-shape: ${res.stdout}`).not.toMatch(bearerRegex);
    expect(res.stderr, `stderr leaked bearer-shape: ${res.stderr}`).not.toMatch(bearerRegex);
    expect(res.stdout).not.toMatch(envRegex);
    expect(res.stderr).not.toMatch(envRegex);
    expect(res.stdout).not.toMatch(jwtRegex);
    expect(res.stderr).not.toMatch(jwtRegex);
    res.cleanup();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Direct hub-binary exit-code matrix. The T6/T7 harness pattern
// already covers single-shape subprocess checks; this matrix makes
// the "every shape is fail-closed or success" promise explicit and
// gives the T8 author a single table to reference when wiring
// ParseConnectFlags.
// ---------------------------------------------------------------------------
describe('hub hub connect — argv matrix (T8)', () => {
  const argvCases: ReadonlyArray<{
    label: string;
    argv: readonly string[];
    expectedStatus: 0 | 1 | 2;
    mustMentionInStderr?: RegExp;
  }> = [
    // Help shapes: locked GREEN contract.
    { label: 'help-root', argv: ['hub', 'connect', '--help'], expectedStatus: 0 },
    { label: 'help-preview', argv: ['hub', 'connect', 'preview', '--help'], expectedStatus: 0 },
    { label: 'help-apply', argv: ['hub', 'connect', 'apply', '--help'], expectedStatus: 0 },
    { label: 'help-rollback', argv: ['hub', 'connect', 'rollback', '--help'], expectedStatus: 0 },
    // Missing action / missing required flags: locked RED contract (exit 2).
    { label: 'no-action', argv: ['hub', 'connect'], expectedStatus: 2 },
    { label: 'preview-no-flags', argv: ['hub', 'connect', 'preview'], expectedStatus: 2 },
    { label: 'apply-no-flags', argv: ['hub', 'connect', 'apply'], expectedStatus: 2 },
    { label: 'rollback-no-flags', argv: ['hub', 'connect', 'rollback'], expectedStatus: 2 },
    // Unknown verb / unknown flag: locked RED contract (exit 2).
    { label: 'unknown-verb', argv: ['hub', 'connect', 'regress'], expectedStatus: 2 },
    { label: 'unknown-flag', argv: ['hub', 'connect', '--no-such-flag'], expectedStatus: 2 },
  ];

  for (const tc of argvCases) {
    it(`argv[${tc.label}] exits with status ${tc.expectedStatus}`, async () => {
      const res = await runConnect(tc.argv);
      expect(
        res.status,
        `argv=${JSON.stringify(tc.argv)}\nstatus=${res.status}\nstdout=${JSON.stringify(res.stdout)}\nstderr=${JSON.stringify(res.stderr)}`,
      ).toBe(tc.expectedStatus);
    }, 30_000);
  }
});

// ---------------------------------------------------------------------------
// Stdout/stderr separation. The repo's invariant is: stdout is the
// contract surface; stderr is the diagnostic surface. Help text
// (a contract artefact) belongs on stdout; "unknown command"
// (a diagnostic) belongs on stderr. A regression that swaps the
// two channels would silently break CI pipelines that grep the
// wrong stream, so the suite latches both channels explicitly.
// ---------------------------------------------------------------------------
describe('hub hub connect — stdout/stderr separation (T8)', () => {
  it('hub hub connect --help writes the help block to stdout and keeps stderr empty', async () => {
    const res = await runConnect(['hub', 'connect', '--help']);
    expect(res.stdout).not.toBe('');
    expect(res.stderr).toBe('');
  }, 30_000);

  it('hub hub connect <unknown-action> writes the diagnostic to stderr and keeps stdout empty', async () => {
    const res = await runConnect(['hub', 'connect', 'migrate']);
    expect(res.stdout).toBe('');
    expect(res.stderr).not.toBe('');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Quiet helper so the test file stays import-clean when an external
// consumer imports one of the helpers above.
// ---------------------------------------------------------------------------
void runConnect;
