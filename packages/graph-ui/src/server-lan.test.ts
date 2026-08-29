import { networkInterfaces } from 'node:os';
import { describe, expect, it } from 'vitest';
import { isLanHost, startGraphUi } from '../server';

const privateInterface = Object.values(networkInterfaces())
  .flatMap((entries) => entries ?? [])
  .find((entry) => entry.family === 'IPv4' && !entry.internal && isLanHost(entry.address))
  ?.address;

describe('Graph UI LAN boundary', () => {
  it('recognizes only private RFC1918 IPv4 hosts', () => {
    expect(isLanHost('10.0.0.10')).toBe(true);
    expect(isLanHost('172.16.0.1')).toBe(true);
    expect(isLanHost('172.31.255.254')).toBe(true);
    expect(isLanHost('192.168.1.20')).toBe(true);

    expect(isLanHost('172.15.0.1')).toBe(false);
    expect(isLanHost('172.32.0.1')).toBe(false);
    expect(isLanHost('8.8.8.8')).toBe(false);
    expect(isLanHost('0.0.0.0')).toBe(false);
    expect(isLanHost('10.example.com')).toBe(false);
    expect(isLanHost('192.168.example')).toBe(false);
    expect(isLanHost('10.999.0.1')).toBe(false);
    expect(isLanHost('localhost')).toBe(false);
  });

  it('rejects public and wildcard bindings even when LAN mode is enabled', async () => {
    await expect(startGraphUi({ GRAPH_UI_HOST: '0.0.0.0', GRAPH_UI_ALLOW_LAN: '1' })).rejects.toThrow('private IPv4');
    await expect(startGraphUi({ GRAPH_UI_HOST: '8.8.8.8', GRAPH_UI_ALLOW_LAN: '1' })).rejects.toThrow('private IPv4');
  });

  it.skipIf(privateInterface === undefined)('disables governed proposal POSTs on an opted-in private LAN binding', async () => {
    const host = privateInterface;
    if (!host) throw new Error('private interface required by test');
    const port = 42000 + Math.floor(Math.random() * 1000);
    const server = await startGraphUi({
      GRAPH_UI_HOST: host,
      GRAPH_UI_PORT: String(port),
      GRAPH_UI_ALLOW_LAN: '1',
      GRAPH_UI_REST_URL: 'http://127.0.0.1:39421',
    });
    try {
      const response = await fetch(`http://${host}:${port}/api/v1/skill-relation-proposals/proposal-1/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(response.status).toBe(405);
      expect(await response.json()).toEqual({ error: { code: 'READ_ONLY', message: 'Graph UI is read-only' } });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
