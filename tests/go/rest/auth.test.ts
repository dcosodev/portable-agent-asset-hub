// tests/go/rest/auth.test.ts
//
// T6 real-subprocess contract for the curated REST client. This
// file owns the .test.ts naming required by the slice, but the
// assertions live in Go:
//
//   tests/go/rest/auth_test.go       (table-driven httptest.Server)
//
// Strategy: the Go test file is the source of truth for every
// auth/JSON/bearer-redaction contract. The TS file is a thin
// subprocess wrapper that:
//   1. compiles the Go tests via tests/go/rest/_rest-harness.ts
//      (one `go test -c` per vitest worker, cached);
//   2. spawns the resulting test binary with `-test.v -test.run`;
//   3. asserts on exit code 0 and the absence of FAIL lines on
//      stderr.
//
// This is the only honest way to satisfy the ".test.ts naming"
// constraint while running real tests with httptest.Server — a
// fake PASS would short-circuit the gate.

import { describe, expect, it } from 'vitest';
import { runRestTest } from './_rest-harness';

// The Go test names below must match the top-level Test* names in
// tests/go/rest/auth_test.go. The harness passes each name as
// `-test.run <name>` so a single TS `it` drives a single Go
// subtest. Failures inside the Go binary abort early — the TS
// `it` then fails with the captured stderr surfaced verbatim.

const GO_AUTH_TESTS = [
  // Bearer-redaction sweep across every status class.
  'TestAuth_RedactsAndPreservesEnvelope/401_unauthorized_preserves_envelope',
  'TestAuth_RedactsAndPreservesEnvelope/403_forbidden_preserves_envelope',
  'TestAuth_RedactsAndPreservesEnvelope/404_not_found_preserves_envelope',
  'TestAuth_RedactsAndPreservesEnvelope/409_conflict_preserves_envelope',
  'TestAuth_RedactsAndPreservesEnvelope/412_precondition_failed_preserves_envelope',
  'TestAuth_RedactsAndPreservesEnvelope/500_internal_preserves_envelope',
  'TestAuth_RedactsAndPreservesEnvelope/503_unavailable_preserves_envelope',
  // Bearer present/absent on the outbound header.
  'TestAuth_BearerHeaderSentOnOutbound',
  'TestAuth_NoBearerWhenEmpty',
  // Happy path + non-envelope body + malformed JSON.
  'TestAuth_HappyPathJSONDecode',
  'TestAuth_NonEnvelopeBodyStillTypedHubError',
  'TestAuth_2xxMalformedJSONReturnsError',
  // Bounded body + redacted sweep.
  'TestAuth_ResponseBodyBounded',
  'TestAuth_RedactionAcrossManyFormats',
  // Curated surface cannot shrink.
  'TestAuth_AllEndpointsExercised',
  // Harness marker.
  'TestRestHarnessMarker',
];

describe('rest auth — table-driven status cases', () => {
  for (const name of GO_AUTH_TESTS) {
    const itName = name.replace(/[/_]/g, '_');
    it(itName, async () => {
      const res = await runRestTest(['-test.run', `^${name}$`]);
      expect(res.status, `go test exited non-zero\nstderr: ${res.stderr}`).toBe(0);
      // Belt-and-braces: stderr must not contain a FAIL line for
      // the subtest we ran. The Go testing package writes
      // "--- FAIL: <name>" on a per-subtest failure; that is
      // the canonical signal the TS layer latches onto.
      expect(res.stderr).not.toMatch(new RegExp(`--- FAIL:.*${name}`));
    }, 60_000);
  }
});
