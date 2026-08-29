import { metrics, trace, type Meter, type Span, type Tracer } from '@opentelemetry/api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addEvent,
  countMetric,
  createNoopTelemetryHandle,
  histogramMetric,
  recordMetric,
  withSpan,
  withSpanSync,
} from '@portable-agent-asset-hub/telemetry';

describe('telemetry fail-open boundary', () => {
  const handle = createNoopTelemetryHandle('standard');

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs an async application callback once when tracer startup throws', async () => {
    vi.spyOn(trace, 'getTracer').mockReturnValue({
      startActiveSpan: () => { throw new Error('provider unavailable'); },
    } as unknown as Tracer);
    const callback = vi.fn(async () => 'ok');

    await expect(withSpan(handle, 'hub.request', {}, callback)).resolves.toBe('ok');
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('runs a sync application callback once when tracer startup throws', () => {
    vi.spyOn(trace, 'getTracer').mockReturnValue({
      startSpan: () => { throw new Error('provider unavailable'); },
    } as unknown as Tracer);
    const callback = vi.fn(() => 'ok');

    expect(withSpanSync(handle, 'hub.request', {}, callback)).toBe('ok');
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('does not turn a business exception into telemetry success', async () => {
    const expected = new Error('business failure');
    await expect(withSpan(handle, 'hub.request', {}, async () => { throw expected; })).rejects.toBe(expected);
  });

  it('drops metric names outside the closed allowlist before touching the meter', () => {
    const createCounter = vi.fn(() => ({ add: vi.fn() }));
    vi.spyOn(metrics, 'getMeter').mockReturnValue({ createCounter } as unknown as Meter);

    recordMetric(handle, 'hub.request.searchSkills', 1, { operation_id: 'searchSkills' });
    expect(createCounter).not.toHaveBeenCalled();

    recordMetric(handle, 'hub.requests', 1, { operation_id: 'searchSkills' });
    expect(createCounter).toHaveBeenCalledTimes(1);
  });

  it('swallows failures from active spans and meters', () => {
    vi.spyOn(trace, 'getActiveSpan').mockReturnValue({
      addEvent: () => { throw new Error('span unavailable'); },
    } as unknown as Span);
    expect(() => addEvent(handle, 'hub.event', {})).not.toThrow();

    vi.spyOn(metrics, 'getMeter').mockReturnValue({
      createCounter: () => { throw new Error('meter unavailable'); },
      createHistogram: () => { throw new Error('meter unavailable'); },
    } as unknown as Meter);
    expect(() => recordMetric(handle, 'hub.requests', 1, {})).not.toThrow();
    expect(() => countMetric(handle, 'hub.requests', 1, {})).not.toThrow();
    expect(() => histogramMetric(handle, 'hub.duration', 1, 'ms', {})).not.toThrow();
  });
});
