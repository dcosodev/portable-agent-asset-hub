import { SqliteStore } from '@portable-agent-asset-hub/storage-sqlite';
import { createActorContext } from '@portable-agent-asset-hub/core';

const args = process.argv.slice(2);
const command = args[0] ?? 'discover';
const dbPath = process.env.AGENT_MEMORY_DB_PATH;
if (!dbPath) { console.error('AGENT_MEMORY_DB_PATH is required'); process.exitCode = 2; } else {
  const store = new SqliteStore(dbPath);
  const actor = createActorContext({ userId: process.env.AGENT_MEMORY_USER_ID ?? 'usr_local', agentId: process.env.AGENT_MEMORY_AGENT_ID ?? 'agt_local', role: 'admin', capabilities: ['read', 'write.skill', 'skill.relation.proposal.read', 'skill.relation.proposal.create', 'skill.relation.proposal.review', 'skill.relation.proposal.apply', 'admin'] });
  try {
    if (command === 'discover') {
      const dryRun = args.includes('--dry-run');
const mode = process.env.RELATION_MODE === 'strict' || process.env.RELATION_MODE === 'exploratory' ? process.env.RELATION_MODE : 'balanced';
      const result = store.transaction(actor, (tx) => tx.relationProposals.discover(actor.scope, { topK: Number(process.env.RELATION_TOP_K ?? 10), mode, dryRun }));
      const bands = { high: 0, medium: 0, low: 0 }; let operational = 0; let semantic = 0;
      for (const proposal of result.proposals) { const band = proposal.confidence >= 0.85 ? 'high' : proposal.confidence >= 0.6 ? 'medium' : 'low'; bands[band] += 1; if (proposal.relationType === 'related_to') semantic += 1; else operational += 1; }
      console.log(`Skills scanned:       ${result.skillsScanned}`);
      console.log(`Candidate pairs:      ${result.candidatePairs}`);
      console.log(`Proposals created:    ${result.proposals.length}`);
      console.log(`High confidence:      ${bands.high}`);
      console.log(`Medium confidence:    ${bands.medium}`);
      console.log(`Low confidence:       ${bands.low}`);
      console.log(`Operational:           ${operational}`);
      console.log(`Semantic:              ${semantic}`);
      console.log(`Mode:                  ${dryRun ? 'dry-run (no persistence)' : 'persist proposals only; canonical relations unchanged'}`);
    } else if (command === 'proposals') {
      const items = store.transaction(actor, (tx) => tx.relationProposals.list(actor.scope, { status: process.env.RELATION_STATUS }));
      for (const item of items) console.log(`${item.id}\t${item.status}\t${item.confidence.toFixed(3)}\t${item.relationType}\t${item.sourceSkillId}@${item.sourceVersion}\t${item.targetSkillId}@${item.targetVersionSnapshot}`);
    } else { console.error(`unknown relations command: ${command}`); process.exitCode = 2; }
  } finally { store.close(); }
}
