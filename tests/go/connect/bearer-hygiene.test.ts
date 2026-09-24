// tests/go/connect/bearer-hygiene.test.ts
//
// T8 RED contract: `hub hub connect` MUST NOT emit bearer-shaped
// strings on stdout or stderr under any input shape. The slice is
// invariant I-07 (bearer hygiene) in action: a single
// accidentally-leaked token in an error path is a security
// regression the gate must catch.
//
// The test surface mirrors internal/output/output.go:
//   * Bearer-prefixed opaque:    `bearer <20+ chars>`
//   * Env-var assignment:        `HUB_BEARER_TOKEN=<value>`
//   * JWT triple-segment:        `<h>.<p>.<s>` with 8+ chars per segment
//
// These are the exact regexes the Go output sink redacts; the test
// layer mirrors them so a silent drift between the binary's
// redactor and the test layer is impossible. The regexes are
// duplicated here from tests/go/connect/_connect-harness.ts so the
// suite is hermetic and self-checking.
//
// Today (pre-T8) every test in this file is RED: the dispatcher
// rejects `hub hub connect` with exit 2 / "unknown command" —
// which IS a diagnostic, so the bearer-hygiene surface for that
// specific diagnostic is GREEN-by-accident. Once T8 lands, the
// SAME assertions flip GREEN and the suite then latches a real
// regression: any future help-text or error-message change that
// accidentally embeds a bearer-shaped string surfaces here.

import { describe, expect, it } from 'vitest';
import {
  looksLikeBearer,
  receiptPath,
  receiptsDir,
  readReceipt,
  runConnect,
  runConnectOnFreshHome,
  runConnectOnSharedHome,
  sharedConnectHome,
  freshConnectTarget,
  createCanonicalConnectFixture,
} from './_connect-harness';
import {
  mkdirSync,
  writeFileSync,
} from 'node:fs';

// Mirror internal/output/output.go redactor regexes (kept in sync
// with tests/go/connect/_connect-harness.ts). The duplication is
// deliberate: any drift between the binary's redactor and the test
// layer surfaces as a regression in this file.
const BEARER_PREFIXED_OPAQUE = /bearer\s+[A-Za-z0-9._~+/=-]{20,}/i;
const HUB_BEARER_ENV_ASSIGNMENT = /\bHUB_BEARER_TOKEN\b\s*=\s*[^\s,'"]+/i;
const JWT_TRIPLE_SEGMENT = /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/;

// Canonical 64-hex digest; used to seed an observedDigest so the
// happy-path tests have a deterministic placeholder. NOT a bearer
// — pure hex.
const FAKE_HEX_64 = '0'.repeat(64);

// 32-byte URL-safe-b64 string (≥ 20 chars) — exactly the kind of
// opaque token the bearer regex matches. 32 chars ensures it
// clears the {20,} lower bound.
const FAKE_BEARER_OPAQUE = 'A'.repeat(32);

// Synthetic JWT triple-segment shape: each segment is 12 chars to
// clear the {8,} lower bound. The 'A's and '1's stay out of the
// canonical 64-hex digest shape so a regex that confuses hex for
// JWT does not regress silently.
const FAKE_JWT = 'Z'.repeat(12) + '.' + '1'.repeat(12) + '.' + 'a'.repeat(12);

describe('hub hub connect — bearer hygiene (T8, I-07)', () => {
  // -----------------------------------------------------------------
  // 1. Sanity: the test's own predicates must classify the seeded
  //    fake bearers correctly. A regression in the regex set would
  //    silently turn every assertion in this file into a no-op.
  // -----------------------------------------------------------------
  describe('looksLikeBearer predicate (mirrors internal/output)', () => {
    it('matches `bearer <opaque>`', () => {
      expect(looksLikeBearer(`prefix bearer ${FAKE_BEARER_OPAQUE} suffix`)).toBe(true);
    });
    it('matches `HUB_BEARER_TOKEN=<value>`', () => {
      expect(looksLikeBearer(`HUB_BEARER_TOKEN=${FAKE_BEARER_OPAQUE}`)).toBe(true);
    });
    it('matches JWT triple-segment', () => {
      expect(looksLikeBearer(FAKE_JWT)).toBe(true);
    });
    it('does not match pure hex digest', () => {
      expect(looksLikeBearer(FAKE_HEX_64)).toBe(false);
    });
    it('does not match short token (under 20 chars)', () => {
      expect(looksLikeBearer('bearer shorttoken')).toBe(false);
    });
  });

  // -----------------------------------------------------------------
  // 2. Help-text bearer hygiene. The help block is the canonical
  //    contract surface; a regression that injects a real or fake
  //    token into --help is a CI-blocker regression.
  // -----------------------------------------------------------------
  describe('help-text bearer hygiene', () => {
    it('hub hub connect --help never emits a bearer-shaped string on stdout', async () => {
      const res = await runConnect(['hub', 'connect', '--help']);
      expect(res.stdout).not.toMatch(BEARER_PREFIXED_OPAQUE);
      expect(res.stdout).not.toMatch(HUB_BEARER_ENV_ASSIGNMENT);
      expect(res.stdout).not.toMatch(JWT_TRIPLE_SEGMENT);
    }, 30_000);

    it('hub hub connect --help never emits a bearer-shaped string on stderr', async () => {
      const res = await runConnect(['hub', 'connect', '--help']);
      expect(res.stderr).not.toMatch(BEARER_PREFIXED_OPAQUE);
      expect(res.stderr).not.toMatch(HUB_BEARER_ENV_ASSIGNMENT);
      expect(res.stderr).not.toMatch(JWT_TRIPLE_SEGMENT);
    }, 30_000);

    it('hub hub connect preview --help never emits a bearer-shaped string on stdout or stderr', async () => {
      const res = await runConnect(['hub', 'connect', 'preview', '--help']);
      expect(res.stdout).not.toMatch(BEARER_PREFIXED_OPAQUE);
      expect(res.stderr).not.toMatch(BEARER_PREFIXED_OPAQUE);
      expect(res.stdout).not.toMatch(HUB_BEARER_ENV_ASSIGNMENT);
      expect(res.stderr).not.toMatch(HUB_BEARER_ENV_ASSIGNMENT);
    }, 30_000);

    it('hub hub connect apply --help never emits a bearer-shaped string on stdout or stderr', async () => {
      const res = await runConnect(['hub', 'connect', 'apply', '--help']);
      expect(res.stdout).not.toMatch(BEARER_PREFIXED_OPAQUE);
      expect(res.stderr).not.toMatch(BEARER_PREFIXED_OPAQUE);
      expect(res.stdout).not.toMatch(HUB_BEARER_ENV_ASSIGNMENT);
      expect(res.stderr).not.toMatch(HUB_BEARER_ENV_ASSIGNMENT);
    }, 30_000);

    it('hub hub connect rollback --help never emits a bearer-shaped string on stdout or stderr', async () => {
      const res = await runConnect(['hub', 'connect', 'rollback', '--help']);
      expect(res.stdout).not.toMatch(BEARER_PREFIXED_OPAQUE);
      expect(res.stderr).not.toMatch(BEARER_PREFIXED_OPAQUE);
      expect(res.stdout).not.toMatch(HUB_BEARER_ENV_ASSIGNMENT);
      expect(res.stderr).not.toMatch(HUB_BEARER_ENV_ASSIGNMENT);
    }, 30_000);
  });

  // -----------------------------------------------------------------
  // 3. Diagnostic-channel bearer hygiene. Every CLI-contract-
  //    violation diagnostic goes through stderr; a regression that
  //    surfaces a real or fake token in the diagnostic is a
  //    security regression the gate MUST catch.
  // -----------------------------------------------------------------
  describe('diagnostic-channel bearer hygiene', () => {
    it('hub hub connect <unknown-action> stderr never emits a bearer-shaped string', async () => {
      const res = await runConnect(['hub', 'connect', 'migrate']);
      expect(res.stderr).not.toMatch(BEARER_PREFIXED_OPAQUE);
      expect(res.stderr).not.toMatch(HUB_BEARER_ENV_ASSIGNMENT);
      expect(res.stderr).not.toMatch(JWT_TRIPLE_SEGMENT);
    }, 30_000);

    it('hub hub connect --unknown-flag stderr never emits a bearer-shaped string', async () => {
      const res = await runConnect(['hub', 'connect', '--no-such-flag']);
      expect(res.stderr).not.toMatch(BEARER_PREFIXED_OPAQUE);
      expect(res.stderr).not.toMatch(HUB_BEARER_ENV_ASSIGNMENT);
      expect(res.stderr).not.toMatch(JWT_TRIPLE_SEGMENT);
    }, 30_000);

    it('hub hub connect apply (missing required flags) stderr never emits a bearer-shaped string', async () => {
      const res = await runConnect(['hub', 'connect', 'apply']);
      expect(res.stderr).not.toMatch(BEARER_PREFIXED_OPAQUE);
      expect(res.stderr).not.toMatch(HUB_BEARER_ENV_ASSIGNMENT);
      expect(res.stderr).not.toMatch(JWT_TRIPLE_SEGMENT);
    }, 30_000);

    it('hub hub connect rollback (missing required flags) stderr never emits a bearer-shaped string', async () => {
      const res = await runConnect(['hub', 'connect', 'rollback']);
      expect(res.stderr).not.toMatch(BEARER_PREFIXED_OPAQUE);
      expect(res.stderr).not.toMatch(HUB_BEARER_ENV_ASSIGNMENT);
      expect(res.stderr).not.toMatch(JWT_TRIPLE_SEGMENT);
    }, 30_000);
  });

  // -----------------------------------------------------------------
  // 4. Inherited-env hygiene. The Go shell MUST NOT inherit a
  //    bearer from a parent shell unless the operator passed it
  //    explicitly. The harness already strips HUB_BEARER_TOKEN*
  //    from the subprocess env; this test confirms the binary
  //    does not echo the inherited env back onto stdout/stderr
  //    when asked to render a help block or a usage diagnostic.
  //
  //    Today (pre-T8) the inherited env is empty in the harness,
  //    so this test is a baseline; once T8 lands, it latches the
  //    redactor's behaviour against an explicit injected value.
  // -----------------------------------------------------------------
  describe('inherited-env bearer hygiene', () => {
    it('hub hub connect --help with HUB_BEARER_TOKEN injected does NOT echo the value on stdout or stderr', async () => {
      const res = await runConnect(
        ['hub', 'connect', '--help'],
        { HUB_BEARER_TOKEN: FAKE_BEARER_OPAQUE },
      );
      // The shell must not echo the bearer on stdout.
      expect(res.stdout).not.toMatch(BEARER_PREFIXED_OPAQUE);
      expect(res.stdout).not.toMatch(HUB_BEARER_ENV_ASSIGNMENT);
      // The shell must not echo the bearer on stderr.
      expect(res.stderr).not.toMatch(BEARER_PREFIXED_OPAQUE);
      expect(res.stderr).not.toMatch(HUB_BEARER_ENV_ASSIGNMENT);
    }, 30_000);

    it('hub hub connect --help with HUB_BEARER_TOKEN_FILE injected does NOT echo the path on stdout or stderr', async () => {
      // A bearer-token file path itself is not a bearer but is
      // sometimes logged by mistake; lock it down here.
      const res = await runConnect(
        ['hub', 'connect', '--help'],
        { HUB_BEARER_TOKEN_FILE: '/tmp/hub-tokens/hub.token' },
      );
      // A path that contains "hub.token" is allowed (not bearer
      // shaped); but a leaked `HUB_BEARER_TOKEN=` assignment is
      // not. The latter is the only thing we lock here.
      expect(res.stdout).not.toMatch(HUB_BEARER_ENV_ASSIGNMENT);
      expect(res.stderr).not.toMatch(HUB_BEARER_ENV_ASSIGNMENT);
    }, 30_000);
  });

  // -----------------------------------------------------------------
  // 5. Bearer never appears in JSON output channels. The slice
  //    mandates that --json payloads NEVER embed a bearer. This
  //    test fires on the diagnostic channel today (the "unknown
  //    command" stderr is non-JSON, so JSON.parse throws); once
  //    T8 lands it fires on the structured preview payload.
  // -----------------------------------------------------------------
  describe('json payload bearer hygiene', () => {
    it('hub hub connect preview --json never emits a bearer-shaped string on stdout', async () => {
      const res = await runConnectOnFreshHome(
        [
          'hub', 'connect', 'preview',
          '--harness', 'hermes',
          '--profile', 'prf_bearer_preview',
          '--snapshot', 'snap_bearer_preview',
          '--target-root', '/tmp/hub-bearer-preview-target',
          '--json',
        ],
        { label: 'bearer-preview' },
      );
      res.cleanup();
      expect(res.stdout).not.toMatch(BEARER_PREFIXED_OPAQUE);
      expect(res.stdout).not.toMatch(HUB_BEARER_ENV_ASSIGNMENT);
      expect(res.stdout).not.toMatch(JWT_TRIPLE_SEGMENT);
    }, 30_000);

    it('hub hub connect apply --json with a FAKE_HEX_64 reviewed-digest never emits a bearer-shaped string on stdout', async () => {
      const res = await runConnectOnFreshHome(
        [
          'hub', 'connect', 'apply',
          '--harness', 'hermes',
          '--profile', 'prf_bearer_apply',
          '--snapshot', 'snap_bearer_apply',
          '--target-root', '/tmp/hub-bearer-apply-target',
          '--reason', 'unit-test-bearer-apply',
          '--request-id', 'req_unit_bearer_apply',
          '--reviewed-digest', FAKE_HEX_64,
          '--json',
        ],
        { label: 'bearer-apply' },
      );
      res.cleanup();
      expect(res.stdout).not.toMatch(BEARER_PREFIXED_OPAQUE);
      expect(res.stdout).not.toMatch(HUB_BEARER_ENV_ASSIGNMENT);
      expect(res.stdout).not.toMatch(JWT_TRIPLE_SEGMENT);
    }, 30_000);
  });

  // -----------------------------------------------------------------
  // 6. Malicious --reason. The amendment authorises an
  //    operator-supplied reason for every mutating verb. A
  //    diagnostic echo of that reason would let an attacker
  //    inject a bearer-shaped string through the CLI and see
  //    it surface in the operator-visible channel.
  //
  //    The Go shell MUST redact bearer-shaped substrings out of
  //    the reason it echoes to stdout/stderr. The redactor is
  //    the same one used by `internal/output/output.go`.
  // -----------------------------------------------------------------
  describe('malicious --reason never echoes a bearer-shaped substring', () => {
    it('apply with a bearer-shaped --reason redacts on stderr (missing-flag diagnostic)', async () => {
      const res = await runConnect([
        'hub', 'connect', 'apply',
        '--reason', `prefix bearer ${FAKE_BEARER_OPAQUE} suffix`,
        '--request-id', 'req_unit_bearer_reason',
      ]);
      expect(res.stderr, `stderr leaked bearer from --reason: ${res.stderr}`).not.toMatch(BEARER_PREFIXED_OPAQUE);
      expect(res.stdout, `stdout leaked bearer from --reason: ${res.stdout}`).not.toMatch(BEARER_PREFIXED_OPAQUE);
    }, 30_000);

    it('rollback with a bearer-shaped --reason redacts on stderr (missing-flag diagnostic)', async () => {
      const res = await runConnect([
        'hub', 'connect', 'rollback',
        '--reason', `audit-note bearer ${FAKE_BEARER_OPAQUE}`,
        '--request-id', 'req_unit_bearer_reason_rb',
      ]);
      expect(res.stderr).not.toMatch(BEARER_PREFIXED_OPAQUE);
      expect(res.stdout).not.toMatch(BEARER_PREFIXED_OPAQUE);
    }, 30_000);

    it('apply with a HUB_BEARER_TOKEN-shaped --reason redacts on stderr', async () => {
      const res = await runConnect([
        'hub', 'connect', 'apply',
        '--reason', `HUB_BEARER_TOKEN=${FAKE_BEARER_OPAQUE}`,
        '--request-id', 'req_unit_bearer_reason_env',
      ]);
      expect(res.stderr).not.toMatch(HUB_BEARER_ENV_ASSIGNMENT);
      expect(res.stdout).not.toMatch(HUB_BEARER_ENV_ASSIGNMENT);
    }, 30_000);

    it('apply with a JWT-shaped --reason redacts on stderr', async () => {
      const res = await runConnect([
        'hub', 'connect', 'apply',
        '--reason', `ticketsys-note ${FAKE_JWT}`,
        '--request-id', 'req_unit_bearer_reason_jwt',
      ]);
      expect(res.stderr).not.toMatch(JWT_TRIPLE_SEGMENT);
      expect(res.stdout).not.toMatch(JWT_TRIPLE_SEGMENT);
    }, 30_000);
  });

  // -----------------------------------------------------------------
  // 7. Receipt-corruption bearer hygiene. The amendment pins
  //    the receipt as a small, bounded JSON object. If the Go
  //    shell or the .mjs child echoes a malicious bearer-shaped
  //    substring from a CORRUPTED receipt back to the operator,
  //    that's a regression. The test seeds a receipt with a
  //    bearer-shaped value in an obvious field (e.g. profileId)
  //    and asserts the rollback subprocess never echoes it on
  //    stdout/stderr.
  // -----------------------------------------------------------------
  describe('receipt-corruption bearer hygiene', () => {
    function seedCorruptedReceipt(home: string, runId: string, profileId: string): void {
      mkdirSync(receiptsDir(home), { recursive: true });
      const receipt = {
        schemaVersion: 1,
        runId,
        targetRoot: '/tmp/hub-receipt-corruption-target',
        lockDir: '/tmp/hub-receipt-corruption-target',
        harness: 'hermes',
        profileId,
        observedDigest: FAKE_HEX_64,
        writtenAt: '2026-08-30T13:00:00.000Z',
      };
      writeFileSync(receiptPath(home, runId), JSON.stringify(receipt));
    }

    it('rollback with bearer-shaped profileId in the receipt does NOT echo the bearer on stdout or stderr', async () => {
      const h = sharedConnectHome('bearer-receipt-pid');
      const t = freshConnectTarget('bearer-receipt-pid');
      try {
        const maliciousPid = `prefix bearer ${FAKE_BEARER_OPAQUE} suffix`;
        seedCorruptedReceipt(h.home, 'run_unit_bearer_pid', maliciousPid);
        const res = await runConnectOnSharedHome(
          [
            'hub', 'connect', 'rollback',
            '--run-id', 'run_unit_bearer_pid',
            '--reason', 'unit-test-bearer-pid',
            '--request-id', 'req_unit_bearer_pid',
          ],
          h.home,
        );
        expect(res.stderr, `stderr leaked bearer from receipt profileId: ${res.stderr}`).not.toMatch(BEARER_PREFIXED_OPAQUE);
        expect(res.stdout, `stdout leaked bearer from receipt profileId: ${res.stdout}`).not.toMatch(BEARER_PREFIXED_OPAQUE);
      } finally {
        try { t.cleanup(); } catch { /* best-effort */ }
        try { h.cleanup(); } catch { /* best-effort */ }
      }
    }, 30_000);

    it('rollback with HUB_BEARER_TOKEN-shaped lockDir in the receipt does NOT echo the assignment on stdout or stderr', async () => {
      const h = sharedConnectHome('bearer-receipt-lockdir');
      const t = freshConnectTarget('bearer-receipt-lockdir');
      try {
        const maliciousLockDir = `HUB_BEARER_TOKEN=${FAKE_BEARER_OPAQUE}`;
        mkdirSync(receiptsDir(h.home), { recursive: true });
        const receipt = {
          schemaVersion: 1,
          runId: 'run_unit_bearer_lockdir',
          targetRoot: t.targetRoot,
          lockDir: maliciousLockDir,
          harness: 'hermes',
          profileId: 'prf_bearer_lockdir',
          observedDigest: FAKE_HEX_64,
          writtenAt: '2026-08-30T13:00:00.000Z',
        };
        writeFileSync(receiptPath(h.home, 'run_unit_bearer_lockdir'), JSON.stringify(receipt));
        const res = await runConnectOnSharedHome(
          [
            'hub', 'connect', 'rollback',
            '--run-id', 'run_unit_bearer_lockdir',
            '--reason', 'unit-test-bearer-lockdir',
            '--request-id', 'req_unit_bearer_lockdir',
          ],
          h.home,
        );
        expect(res.stderr, `stderr leaked HUB_BEARER_TOKEN from receipt lockDir: ${res.stderr}`).not.toMatch(HUB_BEARER_ENV_ASSIGNMENT);
        expect(res.stdout).not.toMatch(HUB_BEARER_ENV_ASSIGNMENT);
      } finally {
        try { t.cleanup(); } catch { /* best-effort */ }
        try { h.cleanup(); } catch { /* best-effort */ }
      }
    }, 30_000);

    it('rollback with JWT-shaped harness in the receipt does NOT echo the JWT on stdout or stderr', async () => {
      const h = sharedConnectHome('bearer-receipt-jwt');
      const t = freshConnectTarget('bearer-receipt-jwt');
      try {
        mkdirSync(receiptsDir(h.home), { recursive: true });
        const receipt = {
          schemaVersion: 1,
          runId: 'run_unit_bearer_jwt',
          targetRoot: t.targetRoot,
          lockDir: t.targetRoot,
          harness: FAKE_JWT,
          profileId: 'prf_bearer_jwt',
          observedDigest: FAKE_HEX_64,
          writtenAt: '2026-08-30T13:00:00.000Z',
        };
        writeFileSync(receiptPath(h.home, 'run_unit_bearer_jwt'), JSON.stringify(receipt));
        const res = await runConnectOnSharedHome(
          [
            'hub', 'connect', 'rollback',
            '--run-id', 'run_unit_bearer_jwt',
            '--reason', 'unit-test-bearer-jwt',
            '--request-id', 'req_unit_bearer_jwt',
          ],
          h.home,
        );
        expect(res.stderr, `stderr leaked JWT from receipt harness: ${res.stderr}`).not.toMatch(JWT_TRIPLE_SEGMENT);
        expect(res.stdout).not.toMatch(JWT_TRIPLE_SEGMENT);
      } finally {
        try { t.cleanup(); } catch { /* best-effort */ }
        try { h.cleanup(); } catch { /* best-effort */ }
      }
    }, 30_000);

    // Belt-and-braces: the receipt fixture path MUST NOT
    // surface a bearer-shaped substring from a previous test
    // run when read with the helper. The helper reads raw
    // bytes; a corrupted receipt with a bearer substring MUST
    // still be detectable as a bearer in the byte stream, so
    // the redactor sees it BEFORE it can reach the operator's
    // tty.
    it('corrupted-receipt byte stream still classifies as bearer so the redactor can see it', async () => {
      const h = sharedConnectHome('bearer-receipt-bytes');
      const t = freshConnectTarget('bearer-receipt-bytes');
      try {
        seedCorruptedReceipt(h.home, 'run_unit_bearer_bytes', `bearer ${FAKE_BEARER_OPAQUE}`);
        const bytes = readReceipt(h.home, 'run_unit_bearer_bytes');
        expect(bytes).not.toBeNull();
        expect(looksLikeBearer(bytes!)).toBe(true);
      } finally {
        try { t.cleanup(); } catch { /* best-effort */ }
        try { h.cleanup(); } catch { /* best-effort */ }
      }
    }, 30_000);
  });

  // -----------------------------------------------------------------
  // 8. Apply-receipt-byte hygiene. A successful apply writes a
  //    receipt; the bytes on disk MUST NOT include a
  //    bearer-shaped substring except possibly inside opaque
  //    digest fields (which are 64-hex — never bearer-shaped).
  //    We assert by reading the receipt bytes after a
  //    successful round-trip and scanning with the three
  //    bearer predicates.
  // -----------------------------------------------------------------
  it('successful apply writes a receipt whose bytes NEVER include a bearer-shaped substring', async () => {
    const h = sharedConnectHome('bearer-receipt-bytes-apply');
    const t = freshConnectTarget('bearer-receipt-bytes-apply');
    // Apply-receipt byte hygiene requires a real apply to
    // land on disk. Seed the canonical DB once and forward
    // database.env to BOTH preview and apply so the
    // re-observed profile matches the seed; otherwise the
    // apply would exit 2 for a missing profile and the
    // receipt-on-disk byte assertion would alias a
    // profile-lookup bug as a bearer-leak regression.
    const database = createCanonicalConnectFixture('bearer-apply-receipt', 'prf_bearer_apply_receipt', 'snap_bearer_apply_receipt');
    try {
      const preview = await runConnectOnSharedHome(
        [
          'hub', 'connect', 'preview',
          '--harness', 'hermes',
          '--profile', 'prf_bearer_apply_receipt',
          '--snapshot', 'snap_bearer_apply_receipt',
          '--target-root', t.targetRoot,
          '--json',
        ],
        h.home,
        database.env,
      );
      expect(preview.status).toBe(0);
      const previewPayload = JSON.parse(preview.stdout) as { planDigest?: string };

      const apply = await runConnectOnSharedHome(
        [
          'hub', 'connect', 'apply',
          '--harness', 'hermes',
          '--profile', 'prf_bearer_apply_receipt',
          '--snapshot', 'snap_bearer_apply_receipt',
          '--target-root', t.targetRoot,
          '--reason', 'unit-test-bearer-apply-receipt',
          '--request-id', 'req_unit_bearer_apply_receipt',
          '--reviewed-digest', previewPayload.planDigest ?? '',
          '--json',
        ],
        h.home,
        database.env,
      );
      expect(apply.status).toBe(0);
      const applyPayload = JSON.parse(apply.stdout) as { runId?: string };

      const bytes = readReceipt(h.home, applyPayload.runId!);
      expect(bytes).not.toBeNull();
      expect(looksLikeBearer(bytes!), `apply receipt contains a bearer-shaped substring: ${bytes}`).toBe(false);
      // Belt-and-braces: scan with the same three predicates
      // the redactor uses, so a regression in the helper above
      // cannot silently make this assertion pass.
      expect(bytes).not.toMatch(BEARER_PREFIXED_OPAQUE);
      expect(bytes).not.toMatch(HUB_BEARER_ENV_ASSIGNMENT);
      expect(bytes).not.toMatch(JWT_TRIPLE_SEGMENT);
    } finally {
      try { database.cleanup(); } catch { /* best-effort */ }
      try { t.cleanup(); } catch { /* best-effort */ }
      try { h.cleanup(); } catch { /* best-effort */ }
    }
  }, 90_000);
});