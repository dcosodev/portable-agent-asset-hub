// tests/go/telemetry/_telemetry-helpers.ts
//
// Shared assertion helpers for the T5 telemetry subprocess tests
// (up-down.test.ts and loopback-only.test.ts). The helpers mirror
// _runtime-helpers.ts so the T2 and T5 surfaces read alike — the
// only difference is the compose-file path (T5 owns the top-level
// docker-compose.observability.yml that the slice adds).
//
// Every helper documents the invariant it locks. Adding a new
// helper is a contract-visible change — a new envelope assertion
// must come with a new test that pins the failure mode the
// envelope rejects.

// KNOWN_COMPOSE_VERBS mirrors the set in tests/go/runtime/fake-docker.mjs.
// Tests that look for a verb must use this set so the contract drift
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
 * shim recognises.
 */
export function findVerbIndex(argv: readonly string[], verb: string): number {
  if (verb === '' || !KNOWN_COMPOSE_VERBS.has(verb)) {
    throw new Error(`_telemetry-helpers: unknown compose verb ${JSON.stringify(verb)}`);
  }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== 'compose') continue;
    for (let j = i + 1; j < argv.length; j += 1) {
      const t = argv[j];
      if (t.startsWith('-')) {
        if (t === '-p' || t === '-f' || t === '--project' || t === '--file') {
          j += 1;
        }
        continue;
      }
      if (t === verb) return j;
      // Unknown non-option token: continue scanning.
    }
  }
  return -1;
}

/**
 * Return the FIRST recorded fake-docker call whose argv contains
 * `compose <verb>` (with any leading flags). Returns undefined when
 * no matching invocation was recorded.
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
 * construction; this helper is the chokepoint every hub-telemetry
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
 * Assert the recorded argv starts with the literal `compose` as
 * the first token. The fake shim's wrapper keeps `compose` at the
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

/**
 * I-10 (loopback-first) defence-in-depth: assert the recorded argv
 * does NOT carry any non-loopback bind literal. The T5 surface
 * binds every published port to 127.0.0.1; a regression that lets
 * `0.0.0.0` / `8.8.8.8` / `::` slip through trips the gate before
 * any public socket can be opened.
 *
 * T5's compose-file surface uses Docker Compose's `127.0.0.1:HOST:CONTAINER`
 * port syntax — the only thing we can grep on is the absence of
 * non-loopback IP literals and the absence of bare port mappings
 * (e.g. `HOST:CONTAINER` with no host literal). Any bare mapping
 * is treated as a regression because Docker Compose resolves it to
 * `0.0.0.0:HOST:CONTAINER`, which violates I-10.
 */
export function assertLoopbackBindingsOnly(ports: readonly string[]): void {
  const NON_LOOPBACK = /^(?:\s*(?:0\.0\.0\.0|::|\[::\]|8\.8\.8\.8|\d+\.\d+\.\d+\.\d+))/;
  for (const p of ports) {
    const trimmed = String(p).trim();
    if (trimmed === '') continue;
    // Bare HOST:CONTAINER mappings with no host IP are forbidden:
    // they default to 0.0.0.0 inside the container's published port
    // semantics. The presence of a colon-separated token with NO
    // leading digit-dot pattern is a strong regression signal.
    if (!/^\d+\.\d+\.\d+\.\d+:/.test(trimmed) && /^\d+:/.test(trimmed)) {
      throw new Error(
        `compose ports MUST bind to a loopback IP literal (127.0.0.1/::1); got bare mapping ${JSON.stringify(p)} (I-10 loopback-first)`,
      );
    }
    if (NON_LOOPBACK.test(trimmed)) {
      throw new Error(
        `compose ports MUST bind to 127.0.0.1/::1 only (I-10); got ${JSON.stringify(p)}`,
      );
    }
  }
}