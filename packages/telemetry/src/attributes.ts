/**
 * Closed allowlist of metric label keys and span attribute keys.
 *
 * The kernel refuses to forward any key outside these sets, regardless of
 * what the caller passes. This is the cardinality and privacy contract:
 * adding a key requires editing this file AND the matching privacy /
 * cardinality tests.
 */

export const ALLOWED_METRIC_LABEL_KEYS: ReadonlySet<string> = Object.freeze(new Set([
  'operation_id',
  'runtime',
  'status_class',
  'error_code_bounded',
  'auth_mode',
  'storage_mode',
  'relation_type',
  'proposal_status',
  'retrieval_primary_class',
  'result_class',
]));

export const ALLOWED_METRIC_NAMES: ReadonlySet<string> = Object.freeze(new Set([
  'hub.requests',
  'hub.request.duration',
  'hub.request.errors',
  'hub.auth.denied',
  'hub.skill.search.calls',
  'hub.skill.search.results',
  'hub.skill.search.duration',
  'hub.retrieval.calls',
  'hub.retrieval.duration',
  'hub.retrieval.candidates',
  'hub.retrieval.selected.skills',
  'hub.retrieval.selected.memories',
  'hub.retrieval.empty',
  'hub.graph.calls',
  'hub.graph.duration',
  'hub.graph.nodes',
  'hub.graph.edges',
  'hub.relation.proposals',
  'hub.relation.apply',
]));

export const ALLOWED_SPAN_ATTRIBUTE_KEYS: ReadonlySet<string> = Object.freeze(new Set([
  // Hub core
  'hub.operation_id',
  'hub.auth_mode',
  'hub.runtime',
  'hub.storage_mode',
  'hub.result_class',
  'hub.error_code_bounded',
  'hub.relation_type',
  'hub.proposal_status',
  'hub.retrieval_primary_class',
  'hub.candidate_count_bounded',
  'hub.selected_skills_bounded',
  'hub.selected_memories_bounded',
  'hub.duration_ms',
  // HTTP semantic conventions subset
  'http.request.method',
  'http.route',
  'http.response.status_code',
  // Stage spans (names only — no payload)
  'hub.stage',
]));

export function isAllowedMetricLabelKey(key: string): boolean {
  return ALLOWED_METRIC_LABEL_KEYS.has(key);
}

export function isAllowedMetricName(name: string): boolean {
  return ALLOWED_METRIC_NAMES.has(name);
}

export function isAllowedSpanAttributeKey(key: string): boolean {
  return ALLOWED_SPAN_ATTRIBUTE_KEYS.has(key);
}