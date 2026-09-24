import { describe, expect, test } from 'bun:test';
import {
  authFileProxyCacheKey,
  readProxySummaryFromCredential,
  resolveAuthFileProxy,
  summarizeProxyUrl,
} from '../src/features/authFiles/proxyInfo';

describe('proxy summary', () => {
  test('reads the pinned exit from a Decodo-style username', () => {
    expect(
      summarizeProxyUrl('socks5h://user-abc123-ip-203.0.113.10:secret@isp.decodo.com:10001')
    ).toEqual({ exit: '203.0.113.10', gateway: 'isp.decodo.com:10001', scheme: 'socks5h' });
  });

  test('falls back to the host for plain user:pass@host:port proxies', () => {
    expect(summarizeProxyUrl('socks5h://ap-user:pw@198.51.100.20:6022')).toEqual({
      exit: '198.51.100.20',
      gateway: '198.51.100.20:6022',
      scheme: 'socks5h',
    });
  });

  test('never exposes the proxy credentials', () => {
    const summary = summarizeProxyUrl('http://someone:top-secret@proxy.example.com:8080');
    expect(JSON.stringify(summary)).not.toContain('top-secret');
    expect(JSON.stringify(summary)).not.toContain('someone');
  });

  test('rejects empty or malformed values', () => {
    expect(summarizeProxyUrl('')).toBeNull();
    expect(summarizeProxyUrl('not a url')).toBeNull();
    expect(summarizeProxyUrl(undefined)).toBeNull();
  });
});

describe('credential file parsing', () => {
  test('keeps only the proxy summary, never the tokens', () => {
    const text = JSON.stringify({
      access_token: 'eyJ-very-secret',
      refresh_token: 'rt-very-secret',
      proxy_url: 'socks5h://u-ip-1.2.3.4:p@gw.example.com:10001',
    });
    const parsed = readProxySummaryFromCredential(text);
    expect(parsed.configured).toBe(true);
    expect(parsed.summary?.exit).toBe('1.2.3.4');
    expect(JSON.stringify(parsed)).not.toContain('very-secret');
  });

  test('treats a missing or blank proxy_url as not configured', () => {
    expect(readProxySummaryFromCredential('{"proxy_url":""}').configured).toBe(false);
    expect(readProxySummaryFromCredential('{}').configured).toBe(false);
    expect(readProxySummaryFromCredential('not json').configured).toBe(false);
  });
});

describe('effective egress', () => {
  const none = { configured: false, summary: null };

  test('credential proxy wins over the global proxy', () => {
    const own = readProxySummaryFromCredential('{"proxy_url":"socks5h://a:b@10.0.0.1:1080"}');
    const info = resolveAuthFileProxy(own, 'http://global.example.com:3128');
    expect(info).toMatchObject({ kind: 'proxy', exit: '10.0.0.1' });
  });

  test('uses the global proxy when the credential has none', () => {
    expect(resolveAuthFileProxy(none, 'http://global.example.com:3128')).toMatchObject({
      kind: 'global',
      gateway: 'global.example.com:3128',
    });
  });

  test('reports a direct connection when neither is set', () => {
    expect(resolveAuthFileProxy(none, '')).toEqual({ kind: 'direct' });
    expect(resolveAuthFileProxy(none, undefined)).toEqual({ kind: 'direct' });
  });

  test('does not guess when a configured proxy cannot be parsed', () => {
    const broken = { configured: true, summary: null };
    expect(resolveAuthFileProxy(broken, '')).toEqual({ kind: 'unknown' });
  });
});

describe('cache key', () => {
  test('changes when the file is rewritten', () => {
    const before = authFileProxyCacheKey({ name: 'a.json', modified: 1, size: 10 });
    const after = authFileProxyCacheKey({ name: 'a.json', modified: 2, size: 10 });
    expect(before).not.toBe(after);
  });
});
