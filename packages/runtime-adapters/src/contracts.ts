// packages/runtime-adapters/src/contracts.ts
//
// Frozen contract surface for the FASE 4 runtime-adapters package. The
// public types declared here are the only shapes external callers
// (scripts/attach-agent-hub.mjs, tests/runtime-adapters/*) may import.
// Everything under src/internal/* and src/<harness>/implementation.ts
// is private to the package and may change without notice.
//
// Design invariants (mirrored in the README and asserted by tests):
//
//   * Previews never touch the target directory: `computePreview` is
//     a pure projection over the inputs and returns a `PlanDigest`
//     plus the rendered plan. `apply` only writes when the caller
//     passes a `--reviewed-digest` that matches the preview and
//     every input has re-validated since the preview.
//
//   * Every `PlanFile.relativePath` is forward-slash, has no leading
//     slash, no `..` segment, no empty segment, and no symlink
//     anywhere along its path. The apply pipeline rejects any
//     `relativePath` that escapes `targetRoot` and every input
//     target root that is itself a symlink.
//
//   * USER.md / SOUL.md are copied byte-for-byte into the target.
//     The renderer never logs, prints, or echoes their bytes —
//     the preview JSON includes only `sha256` + `size`, never the
//     body. The CLI streams the JSON via `--preview-output` and the
//     apply reads the files straight from disk.
//
//   * No secrets ever cross the boundary. The descriptor generators
//     emit environment-only configuration (REST URL, capabilities)
//     with no bearer tokens; the harness-side bin shims resolve the
//     token from their own environment.
//
//   * No native roots are read. The adapter never inspects
//     `.hermes/skills`, `.openclaw/skills`, `workspace-scout`,
//     `~/.codex`, `~/.claude`, or any other historical path. All
//     inputs come from the explicit CLI arguments.

import type { ReadonlyDeep } from './internal/deep-readonly.js';

/** The five harness families the adapter knows how to configure. */
export type HarnessId =
  | 'codex'
  | 'claude-code'
  | 'opencode'
  | 'hermes'
  | 'openclaw';

/** Compile-time list of every supported harness. */
export const HARNESS_IDS: readonly HarnessId[] = [
  'codex',
  'claude-code',
  'opencode',
  'hermes',
  'openclaw',
] as const;

/** Logical, harness-neutral identifier prefixes used by every test. */
export type AdapterLogicalIds = {
  /** Logical agent identifier embedded as a label, never a path. */
  agentId: string;
  /** Logical scope (profile) name embedded as a label, never a path. */
  scopeName: string;
};

/**
 * One file inside a rendered plan. `relativePath` is forward-slash,
 * unprefixed, no `..`, no empty segments. `bytes` is the canonical
 * UTF-8 content the apply will write to disk. `mode` is the
 * filesystem permission the apply will set; the apply never honours
 * a `mode` with setuid/setgid/sticky bits (see `assertSafeMode` in
 * `internal/safe-mode.ts`). `sourceRef` is a logical identifier that
 * tells a reviewer where the bytes came from (e.g. `template:codex`).
 */
export type PlanFile = {
  readonly relativePath: string;
  readonly sha256: string;
  readonly size: number;
  readonly mode: number;
  readonly bytes: Uint8Array;
  readonly sourceRef: string;
};

/**
 * The frozen output of a preview. The plan digest is the SHA-256 of
 * a canonicalised manifest (see `digestPlan`); the apply refuses to
 * proceed unless the caller passes the same digest back through
 * `--reviewed-digest`, which keeps "two operators reviewing the same
 * plan" deterministic.
 */
export type PlanDigest = {
  readonly digest: string;
  readonly algorithm: 'sha256';
  readonly canonicalisedAt: string;
};

export type PreviewInput = Readonly<{
  /** Which harness layout to render. */
  harness: HarnessId;
  /**
   * The directory the apply would write into. The preview never
   * touches it but it must satisfy `assertSafeTargetDir` so the
   * preview surfaces the same shape apply would refuse later.
   */
  targetDir: string;
  /** Logical profile scope. Embedded as a label, never a path. */
  profile: string;
  /**
   * Absolute path to the canonical `USER.md` bytes. Read but never
   * echoed: the preview includes only sha256 + size.
   */
  userFile: string;
  /** Absolute path to the canonical `SOUL.md` bytes. */
  soulFile: string;
  /**
   * REST base URL the descriptor MCP entry will point at. Surfaced in
   * the preview as a logical identifier (no query string, no token).
   */
  restUrl: string;
  /**
   * Absolute path to the MCP stdio entry the descriptor should
   * invoke. Surfaced in the preview as a logical identifier too.
   * The apply never executes this; it is purely a reference stored
   * in the descriptor that the harness will start on first boot.
   */
  mcpEntry: string;
  /** Optional 0600 secret-file reference; the bearer itself never enters a descriptor. */
  authTokenFile?: string;
  /** Logical identifier of the agent the descriptor configures. */
  agentId?: string;
}>;

/**
 * The preview output. `planDigest` is the value the operator must
 * pass back via `--reviewed-digest` to authorise the apply. `files`
 * are the relative paths the apply will write, plus their byte
 * digest/size/mode — never the body of USER.md/SOUL.md.
 */
export type Preview = Readonly<{
  planDigest: PlanDigest;
  harness: HarnessId;
  profile: string;
  agentId: string;
  targetDir: string;
  restUrl: string;
  mcpEntry: string;
  /** Absolute path the preview read USER.md from, re-validated on apply. */
  userFile: string;
  /** Absolute path the preview read SOUL.md from, re-validated on apply. */
  soulFile: string;
  wrapperRelativePath: string;
  files: readonly PlanFile[];
  descriptor: DescriptorPreview;
  commandFragments: readonly CommandFragment[];
  generatedAt: string;
}>;

/**
 * The harness-native MCP descriptor preview. The JSON is normalised
 * to a deterministic key order so two previews of the same inputs
 * produce the same `digest`.
 */
export type DescriptorPreview = Readonly<{
  /** Filename the apply will write the descriptor to. */
  relativePath: string;
  /** A logical descriptor kind, never a verbatim host secret. */
  kind:
    | 'codex-toml'
    | 'claude-code-mcp-json'
    | 'opencode-opencode-json'
    | 'hermes-cli-fragment'
    | 'openclaw-mcp-fragment';
  /** The descriptor body, exact shape per kind. */
  body: ReadonlyDeep<DescriptorBody>;
}>;

export type DescriptorBody =
  | { kind: 'codex-toml'; table: string; sections: readonly CodeTomlSection[] }
  | { kind: 'claude-code-mcp-json'; servers: ReadonlyDeep<ClaudeMcpServer[]> }
  | { kind: 'opencode-opencode-json'; mcp: ReadonlyDeep<OpenCodeMcpServer[]> }
  | { kind: 'hermes-cli-fragment'; argv: readonly string[]; env: ReadonlyDeep<Record<string, string>> }
  | { kind: 'openclaw-mcp-fragment'; server: ReadonlyDeep<OpenclawMcpServer> };

export type CodeTomlSection = Readonly<{ key: string; value: string }>;
export type ClaudeMcpServer = Readonly<{
  name: string;
  command: string;
  args: readonly string[];
  env: ReadonlyDeep<Record<string, string>>;
}>;
export type OpenCodeMcpServer = Readonly<{
  name: string;
  type: 'local';
  command: readonly string[];
  environment: ReadonlyDeep<Record<string, string>>;
  enabled: boolean;
}>;
export type OpenclawMcpServer = Readonly<{
  command: string;
  args: readonly string[];
  env: ReadonlyDeep<Record<string, string>>;
}>;

/**
 * A logical command fragment the operator can paste into the host.
 * Neither secret values nor roots of any prior installation ever
 * appear here — only the bare entry + env that the descriptor needs
 * to spawn the MCP server.
 */
export type CommandFragment = Readonly<{
  label: string;
  argv: readonly string[];
  env: ReadonlyDeep<Record<string, string>>;
}>;

export type ApplyInput = Readonly<{
  preview: Preview;
  targetDir: string;
  /** SHA-256 the operator reviewed. Must match `preview.planDigest.digest`. */
  reviewedDigest: string;
  reason: string;
}>;

export type ApplyResult = Readonly<{
  runId: string;
  planDigest: string;
  writtenFiles: readonly { relativePath: string; mode: number; sha256: string }[];
  backupRoot: string;
  startedAt: string;
  finishedAt: string;
}>;

export type RollbackInput = Readonly<{
  targetDir: string;
  runId: string;
  reason: string;
}>;

export type RollbackResult = Readonly<{
  runId: string;
  restoredFiles: readonly string[];
  finishedAt: string;
}>;

/** A renderer is a pure function from `(profile, restUrl, mcpEntry)` to plan files. */
export type Renderer = Readonly<{
  readonly id: HarnessId;
  readonly rendererVersion: string;
  /** Relative path of the harness-native wrapper file. */
  readonly wrapperRelativePath: string;
  /** The non-secret bytes of the wrapper file (template content). */
  renderWrapper(input: PreviewInput): Uint8Array;
  /** The non-secret bytes of USER.md as it would appear in the target. */
  renderUserCopy(userBytes: Uint8Array): Uint8Array;
  /** The non-secret bytes of SOUL.md as it would appear in the target. */
  renderSoulCopy(soulBytes: Uint8Array): Uint8Array;
  /**
   * The harness-native descriptor preview. Implementations must not
   * reference any historical root or bearer token.
   */
  renderDescriptor(input: PreviewInput): DescriptorBody;
}>;
