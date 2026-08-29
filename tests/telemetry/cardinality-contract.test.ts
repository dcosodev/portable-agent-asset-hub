import { describe, expect, it } from 'vitest';
import {
  scrubMetricLabels,
  scrubAttributes,
  ALLOWED_METRIC_LABEL_KEYS,
  ALLOWED_METRIC_NAMES,
  ALLOWED_SPAN_ATTRIBUTE_KEYS,
  isAllowedMetricLabelKey,
  isAllowedMetricName,
  isAllowedSpanAttributeKey,
} from '@portable-agent-asset-hub/telemetry';

describe('telemetry cardinality contract', () => {
  it('exports a closed allowlist of metric label keys', () => {
    expect(ALLOWED_METRIC_LABEL_KEYS).toBeInstanceOf(Set);
    expect(ALLOWED_METRIC_LABEL_KEYS.size).toBeGreaterThan(0);
    expect(ALLOWED_METRIC_LABEL_KEYS.size).toBeLessThan(20);
  });

  it('exports and enforces the closed metric-name contract', () => {
    expect(ALLOWED_METRIC_NAMES).toBeInstanceOf(Set);
    expect(ALLOWED_METRIC_NAMES.size).toBe(19);
    expect(isAllowedMetricName('hub.requests')).toBe(true);
    expect(isAllowedMetricName('hub.request.duration')).toBe(true);
    expect(isAllowedMetricName('hub.request.searchSkills')).toBe(false);
    expect(isAllowedMetricName('hub.request.req-123')).toBe(false);
    expect(isAllowedMetricName('hub.query.select-1')).toBe(false);
  });

  it('exports a closed allowlist of span attribute keys', () => {
    expect(ALLOWED_SPAN_ATTRIBUTE_KEYS).toBeInstanceOf(Set);
    expect(ALLOWED_SPAN_ATTRIBUTE_KEYS.size).toBeGreaterThan(0);
    expect(ALLOWED_SPAN_ATTRIBUTE_KEYS.size).toBeLessThan(40);
  });

  it('recognizes well-known allowed label keys', () => {
    for (const k of [
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
    ]) {
      expect(isAllowedMetricLabelKey(k)).toBe(true);
    }
  });

  it('rejects every high-cardinality or sensitive label', () => {
    for (const k of [
      'query',
      'prompt',
      'body',
      'skill_id',
      'request_id',
      'trace_id',
      'session_id',
      'user_id',
      'agent_id',
      'token',
      'authorization',
      'resource_path',
      'runtime_session_id',
      'password',
      'api_key',
    ]) {
      expect(isAllowedMetricLabelKey(k)).toBe(false);
    }
  });

  it('recognizes well-known allowed span attribute keys', () => {
    for (const k of [
      'hub.operation_id',
      'http.request.method',
      'http.route',
      'http.response.status_code',
      'hub.auth_mode',
      'hub.runtime',
      'hub.storage_mode',
      'hub.result_class',
    ]) {
      expect(isAllowedSpanAttributeKey(k)).toBe(true);
    }
  });

  it('scrubs metric labels down to the allowlist only', () => {
    const labels = {
      operation_id: 'searchSkills',
      runtime: 'hermes',
      result_class: 'success',
      // the following should all be dropped:
      query: 'select 1',
      request_id: 'req-1',
      trace_id: 'trace-1',
      session_id: 'sess-1',
      user_id: 'u-1',
      agent_id: 'a-1',
      skill_id: 'k-1',
      token: 'ghp_xx',
    };
    const scrubbed = scrubMetricLabels(labels);
    expect(Object.keys(scrubbed).sort()).toEqual(['operation_id', 'result_class', 'runtime']);
    for (const k of Object.keys(scrubbed)) {
      expect(ALLOWED_METRIC_LABEL_KEYS.has(k)).toBe(true);
    }
  });

  it('scrubs span attributes down to the allowlist only', () => {
    const attrs = {
      'hub.operation_id': 'searchSkills',
      'http.request.method': 'GET',
      query: 'select 1',
      body: '{ "password": "x" }',
      request_id: 'req-1',
      skill_id: 'k-1',
      resource_path: '/x',
    };
    const scrubbed = scrubAttributes(attrs);
    expect(Object.keys(scrubbed).sort()).toEqual(['http.request.method', 'hub.operation_id']);
  });

  it('produces bounded number of unique label sets even with varying payloads', () => {
    // Simulate 1000 distinct operations with varying forbidden fields.
    // Allowed label keys are bounded; the resulting series cardinality must
    // depend ONLY on allowed labels, not on the dynamic payloads.
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      const labels = scrubMetricLabels({
        operation_id: ['searchSkills', 'resolveRetrieval', 'getMemory'][i % 3]!,
        runtime: ['hermes', 'codex'][i % 2]!,
        result_class: ['success', 'client_error', 'server_error'][i % 3]!,
        query: `select ${i}`,
        request_id: `req-${i}`,
        user_id: `u-${i}`,
      });
      const key = JSON.stringify([...Object.entries(labels)].sort());
      seen.add(key);
    }
    expect(seen.size).toBeLessThanOrEqual(3 * 2 * 3); // 3 ops × 2 runtimes × 3 results = 18
  });
});