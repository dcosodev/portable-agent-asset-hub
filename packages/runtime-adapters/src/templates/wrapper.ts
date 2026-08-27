// packages/runtime-adapters/src/templates/wrapper.ts
//
// The wrapper is a small plain-text file the harness reads at boot.
// It is intentionally a *pointer*, not the data: the data lives in
// the canonical SQLite database, available through the agent-memory
// MCP server the descriptor registers. This file is the only thing
// each harness reads at startup, and it is the only place every
// harness agrees on what to load.

/**
 * The harness-neutral wrapper body. Every harness renders this same
 * string plus a tiny harness-specific footer; the byte stream is
 * deterministic and the file is small (a few hundred bytes).
 *
 * Conventions enforced here:
 *
 *   * "Database is the authority" — explicit reminder that the
 *     canonical USER/SOUL and skills live in the agent-memory hub,
 *     not on disk.
 *   * "Do not read native roots" — explicit reminder that
 *     `.hermes/skills`, `.openclaw/skills`, `workspace-scout`, or
 *     any historical install must not be inspected.
 *   * "Load USER + SOUL via the MCP server" — operator-facing copy.
 *   * "scope/profile explicit" — every tool call carries the
 *     `scope=<profile>` so the same hub can serve multiple agents.
 *   * "search_skills metadata-only, get_skill body" — these are the
 *     exact MCP tool names the operator must call.
 *   * "list/read resource" — exact resource operations.
 *   * "search/get memory" — exact memory operations.
 *   * "no tokens in this file" — belt and braces reminder.
 *   * "no native skills/agents paths" — explicit reminder.
 */
export function commonWrapperBody(input: {
  harnessLabel: string;
  profile: string;
  agentId: string;
}): string {
  return [
    `# portable-agent-asset-hub wrapper (${input.harnessLabel})`,
    ``,
    `This file is a pointer, not the data. USER.md and SOUL.md are the`,
    `small canonical bootstrap copies selected for this harness. Skills`,
    `and episodic memories live in the agent-memory SQLite hub,`,
    `registered as the MCP server named \`agent-memory\`. No native`,
    `skills directory, agents layout, or historical runtime output may`,
    `override the hub.`,
    ``,
    `## Operating rules`,
    ``,
    `1. Load the local \`USER.md\` and \`SOUL.md\` bootstrap files at`,
    `   startup. They define user context and agent behaviour; they are`,
    `   not skill records and must not be queried with \`get_skill\`.`,
    `2. The database is authoritative for skills and episodic memory.`,
    `   Do not read native roots or historical skill installations.`,
    `3. Before any procedural, technical, operational, configuration,`,
    `   deployment, debugging, migration, or maintenance action, call`,
    `   \`resolve_retrieval\` and wait for canonical retrieval to finish.`,
    `   Canonical skills override ad-hoc assumptions when applicable.`,
    `   A no-match result permits normal general knowledge; never invent`,
    `   a match. Then use \`get_skill\` only for selected bodies and`,
    `   \`list_skill_resources\` / \`read_skill_resource\` as needed.`,
    `4. Use \`resolve_skill_graph\`, \`get_skill_relations\`, and`,
    `   \`get_skill_dependents\` for structural/version explanations.`,
    `5. Memory: call \`search_memories\` narrowly, then \`get_memory\`.`,
    `   Authorization scope is bound by the MCP/REST actor configuration;`,
    `   do not invent a scope parameter that a tool schema does not expose.`,
    `6. The profile and agent labels below identify this bootstrap`,
    `   selection; they do not replace server-side authorization.`,
    `7. No bearer token, cookie, or API key is stored in this file.`,
    `   The MCP server reads credentials from the host environment.`,
    ``,
    `## Scope / profile`,
    ``,
    `- harness_label: ${input.harnessLabel}`,
    `- agent_id: ${input.agentId}`,
    `- profile: ${input.profile}`,
    ``,
  ].join('\n');
}

/**
 * Codex-specific footer. Codex does not require anything beyond the
 * common body, but we keep the harness-specific footer so future
 * Codex-only rules have a single, greppable location.
 */
export function codexFooter(): string {
  return [
    `## Codex notes`,
    ``,
    `- Codex reads this file as \`AGENTS.md\` at the agent root.`,
    `- Codex CLI also reads \`.codex/config.toml\` for MCP servers;`,
    `  the descriptor generated alongside this wrapper points Codex`,
    `  at the same \`agent-memory\` MCP entry as every other harness.`,
    ``,
  ].join('\n');
}

/**
 * Claude Code specific footer.
 */
export function claudeFooter(): string {
  return [
    `## Claude Code notes`,
    ``,
    `- Claude Code reads this file as \`CLAUDE.md\`.`,
    `- Claude Code also reads \`.mcp.json\` for MCP servers; the`,
    `  descriptor generated alongside this wrapper points Claude at`,
    `  the same \`agent-memory\` MCP entry as every other harness.`,
    ``,
  ].join('\n');
}

/**
 * OpenCode specific footer.
 */
export function opencodeFooter(): string {
  return [
    `## OpenCode notes`,
    ``,
    `- OpenCode reads this file as \`AGENTS.md\` at the agent root.`,
    `- OpenCode also reads \`opencode.json\` for MCP servers; the`,
    `  descriptor generated alongside this wrapper points OpenCode`,
    `  at the same \`agent-memory\` MCP entry as every other harness.`,
    ``,
  ].join('\n');
}

/**
 * Hermes specific footer.
 */
export function hermesFooter(): string {
  return [
    `## Hermes notes`,
    ``,
    `- Hermes reads this file as \`AGENTS.md\` at the agent root.`,
    `- The MCP descriptor is a logical \`hermes mcp add\` command`,
    `  fragment; the apply does NOT execute it. The operator must`,
    `  paste the fragment once into the Hermes CLI to register the`,
    `  server. The fragment points at the same \`agent-memory\` MCP`,
    `  entry as every other harness.`,
    ``,
  ].join('\n');
}

/**
 * OpenClaw specific footer. OpenClaw treats the wrapper as
 * `MEMORY.md` (its native memory pointer file) rather than
 * `AGENTS.md`.
 */
export function openclawFooter(): string {
  return [
    `## OpenClaw notes`,
    ``,
    `- OpenClaw reads this file as \`MEMORY.md\` at the agent root.`,
    `- The MCP descriptor is a logical \`openclaw mcp set\``,
    `  fragment; the apply does NOT execute it. The operator must`,
    `  paste the fragment once into the OpenClaw CLI to register the`,
    `  server. The fragment points at the same \`agent-memory\` MCP`,
    `  entry as every other harness.`,
    ``,
  ].join('\n');
}
