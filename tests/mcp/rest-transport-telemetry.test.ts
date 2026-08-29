import { describe, expect, it, vi, afterEach } from 'vitest';
import { RestTransport } from '@portable-agent-asset-hub/mcp';

afterEach(() => {
  vi.unstubAllGlobals();
});

function captureHeaders(): { seen: Record<string, string>; fetchMock: ReturnType<typeof vi.fn> } {
  const seen: Record<string, string> = {};
  const fetchMock = vi.fn(async (_url: string, init: { headers?: Record<string, string> }) => {
    const headers = init.headers ?? {};
    for (const [k, v] of Object.entries(headers)) seen[k.toLowerCase()] = String(v);
    return {
      status: 200,
      headers: new Headers(),
      text: async () => '{}',
    };
  });
  vi.stubGlobal('fetch', fetchMock);
  return { seen, fetchMock };
}

describe('RestTransport W3C propagation + reserved headers', () => {
  it('model-supplied authorization cannot override the bearer token', async () => {
    const transport = new RestTransport({ restBaseUrl: 'http://127.0.0.1:1', bearerToken: 'real-token' });
    const { seen, fetchMock } = captureHeaders();
    await transport.send({
      method: 'GET',
      path: '/api/v1/health',
      headers: { authorization: 'Bearer fake-override' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(seen.authorization).toBe('Bearer real-token');
  });

  it('model-supplied x-request-id is dropped to avoid spoofing', async () => {
    const transport = new RestTransport({ restBaseUrl: 'http://127.0.0.1:1', bearerToken: 'real-token' });
    const { seen } = captureHeaders();
    await transport.send({
      method: 'GET',
      path: '/api/v1/health',
      headers: { 'x-request-id': 'req-fake' },
    });
    expect(seen['x-request-id']).toBeUndefined();
  });

  it('model-supplied identity headers are dropped', async () => {
    const transport = new RestTransport({ restBaseUrl: 'http://127.0.0.1:1', bearerToken: 'real-token' });
    const { seen } = captureHeaders();
    await transport.send({
      method: 'GET',
      path: '/api/v1/health',
      headers: {
        'x-mcp-actor': 'usr_spoof',
        'x-mcp-user-id': 'usr_spoof',
        'x-mcp-role': 'admin',
      },
    });
    expect(seen['x-mcp-actor']).toBeUndefined();
    expect(seen['x-mcp-user-id']).toBeUndefined();
    expect(seen['x-mcp-role']).toBeUndefined();
  });

  it('model-supplied traceparent is dropped; the kernel emits the actual carrier', async () => {
    const transport = new RestTransport({ restBaseUrl: 'http://127.0.0.1:1', bearerToken: 'real-token' });
    const { seen } = captureHeaders();
    await transport.send({
      method: 'GET',
      path: '/api/v1/health',
      headers: { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' },
    });
    // When no active OTel context is present (default test), the kernel
    // emits no carrier at all. Either way the spoofed traceparent MUST
    // NOT appear verbatim in the outbound headers.
    if (seen.traceparent !== undefined) {
      expect(seen.traceparent).not.toBe('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');
    }
  });

  it('forwards benign caller-supplied headers', async () => {
    const transport = new RestTransport({ restBaseUrl: 'http://127.0.0.1:1', bearerToken: 'real-token' });
    const { seen } = captureHeaders();
    await transport.send({
      method: 'POST',
      path: '/api/v1/memories',
      headers: {
        'if-match': '"v1"',
        'idempotency-key': 'idem-001',
        'x-agent-operation-mode': 'analysis',
      },
      body: { id: 'mem_1', content: 'hello', scope: { ownerUserId: 'u', agentId: 'a' } },
    });
    expect(seen['if-match']).toBe('"v1"');
    expect(seen['idempotency-key']).toBe('idem-001');
    expect(seen['x-agent-operation-mode']).toBe('analysis');
    expect(seen['content-type']).toBe('application/json');
  });
});