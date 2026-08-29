import { describe, expect, it } from 'vitest';
import {
  createNoopTelemetryHandle,
  withSpan,
  withSpanSync,
  addEvent,
  recordMetric,
  countMetric,
  histogramMetric,
  type TelemetryLevel,
} from '@portable-agent-asset-hub/telemetry';

describe('telemetry noop kernel', () => {
  const levels: TelemetryLevel[] = ['off', 'basic', 'standard', 'debug'];

  for (const level of levels) {
    it(`createNoopTelemetryHandle returns a no-op handle for level=${level}`, () => {
      const handle = createNoopTelemetryHandle(level);
      expect(handle.level).toBe(level);
      expect(typeof handle.shutdown).toBe('function');
    });
  }

  it('shutdown resolves synchronously (no provider means nothing to flush)', async () => {
    const handle = createNoopTelemetryHandle('basic');
    await expect(handle.shutdown()).resolves.toBeUndefined();
    // idempotent
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });

  it('withSpan invokes the block and returns its result without throwing', async () => {
    const handle = createNoopTelemetryHandle('off');
    const result = await withSpan(handle, 'hub.request', { 'hub.operation_id': 'searchSkills' }, async () => 42);
    expect(result).toBe(42);
  });

  it('withSpanSync returns the block result without throwing', () => {
    const handle = createNoopTelemetryHandle('off');
    const result = withSpanSync(handle, 'hub.skill.search', { 'hub.operation_id': 'searchSkills' }, () => 'ok');
    expect(result).toBe('ok');
  });

  it('addEvent does not throw without a provider', () => {
    const handle = createNoopTelemetryHandle('basic');
    expect(() => addEvent(handle, 'retrieval.empty', { result_class: 'empty' })).not.toThrow();
  });

  it('recordMetric / countMetric / histogramMetric do not throw without a provider', () => {
    const handle = createNoopTelemetryHandle('standard');
    expect(() => recordMetric(handle, 'hub.requests', 1, { operation_id: 'searchSkills' })).not.toThrow();
    expect(() => countMetric(handle, 'hub.auth.denied', 1, { operation_id: 'getMemory', runtime: 'hermes' })).not.toThrow();
    expect(() => histogramMetric(handle, 'hub.request.duration', 12, 'ms', { operation_id: 'searchSkills' })).not.toThrow();
  });

  it('helpers swallow errors thrown by user callbacks and still resolve', async () => {
    const handle = createNoopTelemetryHandle('debug');
    await expect(
      withSpan(handle, 'hub.request', {}, async () => { throw new Error('boom'); }),
    ).rejects.toBeInstanceOf(Error);
  });
});