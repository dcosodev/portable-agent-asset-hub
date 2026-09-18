// tests/go/rest/token-reader.test.ts
//
// T6 real-subprocess contract for rest.ReadTokenFile. Same
// harness pattern as auth.test.ts: the Go test file at
// tests/go/rest/auth_test.go (token_reader_test.go section) owns
// the assertions; this TS file owns the subprocess boundary.
//
// The Go assertions cover:
//
//   * TestTokenReader_RejectsSymlink      — non-symlink enforcement
//   * TestTokenReader_RejectsWrongMode    — file mode != 0600 → reject
//   * TestTokenReader_RejectsDirectory    — directory → reject
//   * TestTokenReader_RejectsEmptyPath    — empty/whitespace → reject
//   * TestTokenReader_RejectsMissing      — missing file → reject
//   * TestTokenReader_HappyPath           — regular 0600 → bearer bytes
//   * TestTokenReader_ErrorMessagesNeverContainBearer
//
// Every rejection path also runs the redaction sweep so the
// canonical bearer never surfaces in any error message.

import { describe, expect, it } from 'vitest';
import { runRestTest } from './_rest-harness';

const GO_TOKEN_TESTS = [
  'TestTokenReader_RejectsSymlink',
  'TestTokenReader_RejectsWrongMode',
  'TestTokenReader_RejectsDirectory',
  'TestTokenReader_RejectsEmptyPath',
  'TestTokenReader_RejectsMissing',
  'TestTokenReader_HappyPath',
  'TestTokenReader_ErrorMessagesNeverContainBearer',
];

describe('rest token reader — file permission / redaction contract', () => {
  for (const name of GO_TOKEN_TESTS) {
    it(name, async () => {
      const res = await runRestTest(['-test.run', `^${name}$`]);
      expect(res.status, `go test exited non-zero\nstderr: ${res.stderr}`).toBe(0);
      expect(res.stderr).not.toMatch(new RegExp(`--- FAIL:.*${name}`));
    }, 60_000);
  }
});
