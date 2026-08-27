import { createHash } from 'node:crypto';
import { HubError } from '../errors.js';

export const RETRIEVAL_CATEGORIES = [
  'conversational', 'general_knowledge', 'procedural', 'operational', 'configuration',
  'deployment', 'debugging', 'migration', 'maintenance', 'personal_context',
] as const;
export type RetrievalCategory = (typeof RETRIEVAL_CATEGORIES)[number];

export interface RetrievalClassification { primary: RetrievalCategory; labels: RetrievalCategory[] }
export interface RetrievalPolicyDecision { skillRetrievalRequired: boolean; memoryRetrievalRequired: boolean }
export interface RetrievalLimits { maxCandidates: number; maxGraphDepth: number; maxResolvedSkills: number; maxBodyBytes: number; canonicalThreshold: number; supportingThreshold: number }
export const DEFAULT_RETRIEVAL_LIMITS: Readonly<RetrievalLimits> = Object.freeze({
  maxCandidates: 20, maxGraphDepth: 8, maxResolvedSkills: 64, maxBodyBytes: 2 * 1024 * 1024,
  canonicalThreshold: 0.7, supportingThreshold: 0.35,
});

const TERMS: Readonly<Record<RetrievalCategory, readonly RegExp[]>> = Object.freeze({
  conversational: [/^(hola|hello|gracias|thanks|qué tal|how are you)\b/iu],
  general_knowledge: [/\b(qué es|what is|explain|explica|historia|definition|definición)\b/iu],
  procedural: [/\b(cómo|how to|pasos|steps|procedimiento|procedure|guía|guide|implementa|implement)\b/iu],
  operational: [/\b(ejecuta|run|opera|operate|arranca|start|detén|stop|automatiza|automate)\b/iu],
  configuration: [/\b(configura|configure|configuration|ajusta|setup|enable|disable|habilita|deshabilita)\b/iu],
  deployment: [/\b(despliega|deploy|deployment|kubernetes|helm|eks|producción|production)\b/iu],
  debugging: [/\b(debug|debugging|depura|diagnostica|diagnose|error|falla|bug|traceback)\b/iu],
  migration: [/\b(migra|migrate|migration|upgrade|portar|convertir|convert)\b/iu],
  maintenance: [/\b(mantenimiento|maintenance|actualiza|update|limpia|cleanup|backup|restore|repara|repair)\b/iu],
  personal_context: [/\b(mi|mis|mío|nuestro|como solemos|my|mine|our|as usual|preferencia|preference|perfil|profile)\b/iu],
});

const SKILL_REQUIRED = new Set<RetrievalCategory>(['procedural', 'operational', 'configuration', 'deployment', 'debugging', 'migration', 'maintenance']);

export function classifyRetrievalRequest(query: string): RetrievalClassification {
  if (typeof query !== 'string' || query.trim().length === 0 || query.length > 8192) throw new HubError('VALIDATION', 'query must be 1..8192 characters', 400);
  const labels = RETRIEVAL_CATEGORIES.filter((category) => TERMS[category].some((term) => term.test(query)));
  if (labels.length === 0) labels.push('general_knowledge');
  const priority: RetrievalCategory[] = ['migration', 'deployment', 'debugging', 'configuration', 'maintenance', 'operational', 'procedural', 'personal_context', 'general_knowledge', 'conversational'];
  const primary = priority.find((label) => labels.includes(label)) ?? labels[0]!;
  return { primary, labels: [...labels].sort((a, b) => RETRIEVAL_CATEGORIES.indexOf(a) - RETRIEVAL_CATEGORIES.indexOf(b)) };
}

export function retrievalPolicy(classification: RetrievalClassification): RetrievalPolicyDecision {
  return {
    skillRetrievalRequired: classification.labels.some((label) => SKILL_REQUIRED.has(label)),
    memoryRetrievalRequired: classification.labels.includes('personal_context'),
  };
}

export function retrievalQueryDigest(query: string): string { return createHash('sha256').update(query, 'utf8').digest('hex'); }

export function boundedAuditQuery(query: string): string {
  return query
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/gu, '[REDACTED_PEM]')
    .replace(/\bauthorization\s*:\s*(?:bearer|basic)\s+[^\s,;]+/giu, 'authorization: [REDACTED]')
    .replace(/\b(?:bearer|basic)\s+[A-Za-z0-9_+/=-]{8,}/gu, '[REDACTED_AUTH]')
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+\b/gu, '[REDACTED_JWT]')
    .replace(/\b((?:token|password|secret|api[_-]?key|client[_-]?secret|cookie|set-cookie|aws[_-]?(?:access[_-]?key[_-]?id|secret[_-]?access[_-]?key)|private[_-]?key|jwt))\s*[:=]\s*[^\s,;]+/giu, '$1=[REDACTED]')
    .slice(0, 512);
}

export function retrievalKeywords(query: string): string[] {
  const stop = new Set(['this','that','with','from','into','como','esta','este','para','desde','hacia','the','and','una','uno','los','las','del','por','que','qué','how','como']);
  const rawTokens = [...new Set(query.toLocaleLowerCase('en-US').normalize('NFKC').split(/[^\p{L}\p{N}_.+-]+/u).filter((token) => token.length >= 2 && token.length <= 64))];
  const preferred = rawTokens.filter((token) => token.length >= 3 && !stop.has(token));
  return (preferred.length > 0 ? preferred : rawTokens).slice(0, 12);
}
