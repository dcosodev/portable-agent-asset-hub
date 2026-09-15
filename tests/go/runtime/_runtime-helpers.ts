// tests/go/runtime/_runtime-helpers.ts
//
// Shared assertion helpers for the T2 runtime subprocess tests
// (up-down.test.ts and status.test.ts). The helpers are kept here
// — NOT inside the harness module — so the harness stays focused
// on subprocess orchestration (build / PATH / rig install) and the
// contract assertions stay separately auditable.
//
// The helpers are written against the same compose-argv shape the
// fake-docker.mjs shim understands: a Compose verb may be preceded
// by any combination of `-p <project>` / `-f <yaml>` / `-d` flags,
// so the helpers scan for the verb rather than pinning a fixed
// argv index. That keeps the tests robust against future flag
// re-orderings (e.g. Compose adding `--quiet-pull` between `-d`
// and the verb).
//
// Every helper documents the invariant it locks. Adding a new
// helper is a contract-visible change — a new envelope assertion
// must come with a new test that pins the failure mode the
// envelope rejects.

// KNOWN_COMPOSE_VERBS mirrors the set in fake-docker.mjs. Tests
// that look for a verb must use this set so the contract drift
// between the test and the shim is impossible.
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

/**
 * Locate the index of the FIRST compose `argv[0] === 'compose'`
 * followed by the supplied verb, skipping flags and their values
 * (we treat `-p`, `-f`, `--project`, `--file` as value flags so
 * `<project>` / `<yaml>` are not mistaken for verbs). Returns -1
 * when no such call is present.
 *
 * The flag-skip logic mirrors `locateComposeVerb` in
 * fake-docker.mjs so the test enumerates the same envelope the
 * shim recognises. Adding a new value flag here MUST also land in
 * the shim's `locateComposeVerb`.
 */
export function findVerbIndex(argv: readonly string[], verb: string): number {
  if (verb === '' || !KNOWN_COMPOSE_VERBS.has(verb)) {
    throw new Error(`_runtime-helpers: unknown compose verb ${JSON.stringify(verb)}`);
  }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== 'compose') continue;
    for (let j = i + 1; j < argv.length; j += 1) {
      const t = argv[j];
      if (t.startsWith('-')) {
        // Value-bearing short / long flags. The shim recognises
        // the same set; we mirror it bit-for-bit so the tests do
        // not silently drift out of sync.
        if (t === '-p' || t === '-f' || t === '--project' || t === '--file') {
          j += 1;
        }
        continue;
      }
      if (t === verb) return j;
      // Unknown non-option token: continue scanning. Compose
      // versions can inject positionals before the verb; pin only
      // the verb we asked for, not the position it occupies.
    }
    // We saw `compose` but no matching verb — keep scanning in
    // case a future refactor pushes multiple `compose` invocations
    // into one transcript (e.g. a forwarded wrapper).
  }
  return -1;
}

/**
 * Return the FIRST recorded fake-docker call whose argv contains
 * `compose <verb>` (with any leading flags). The shim records one
 * JSONL line per `docker` invocation; the helper returns undefined
 * when none of the recorded invocations match.
 */
export function findComposeCall<T extends { argv: string[] }>(
  calls: readonly T[],
  verb: string,
): T | undefined {
  for (const c of calls) {
    if (findVerbIndex(c.argv, verb) >= 0) return c;
  }
  return undefined;
}

/**
 * Defence-in-depth: assert the recorded argv carries no `-v` or
 * `--volumes` token. The Service layer enforces the absence by
 * construction; this helper is the chokepoint every hub-runtime
 * test calls so a refactor that adds the flag quietly trips the
 * gate before any volumes can be removed from a real Compose
 * stack.
 */
export function assertNoVolumeFlag(argv: readonly string[]): void {
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-v') {
      throw new Error(
        `compose argv must NOT contain the literal -v flag (got argv=${JSON.stringify(argv)})`,
      );
    }
    if (a === '--volumes') {
      throw new Error(
        `compose argv must NOT contain --volumes (got argv=${JSON.stringify(argv)})`,
      );
    }
  }
}

/**
 * Assert the recorded argv carries the literal `compose` as
 * argv[0] (after skipping any wrapper-supplied shell preamble the
 * shim ignores). The fake shim's wrapper keeps `compose` at the
 * first positional; locking that here ensures any future wrapper
 * refactor is visible to the contract surface.
 */
export function expectComposeLeader(argv: readonly string[]): void {
  if (argv.length === 0 || argv[0] !== 'compose') {
    throw new Error(
      `compose argv must start with the literal 'compose' (got argv=${JSON.stringify(argv)})`,
    );
  }
}
