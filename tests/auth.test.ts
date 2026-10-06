import { describe, expect, it } from 'vitest';
import { extractBearerToken, extractSiteKey, generateApiKey, isAllowedDomain } from '../src/core/auth';

describe('Auth & Domain Validation Engine', () => {
  it('generates secure API keys with prefix', () => {
    const key = generateApiKey('vfu_live_');
    expect(key.startsWith('vfu_live_')).toBe(true);
    expect(key.length).toBeGreaterThan(30);
  });

  it('extracts bearer token from Authorization header', () => {
    expect(extractBearerToken('Bearer my_secret_token_123')).toBe('my_secret_token_123');
    expect(extractBearerToken('bearer my_secret_token_123')).toBe('my_secret_token_123');
    expect(extractBearerToken('Basic dXNlcjpwYXNz')).toBeNull();
    expect(extractBearerToken('')).toBeNull();
    expect(extractBearerToken(null)).toBeNull();
  });

  it('extracts site key from headers or request', () => {
    const req1 = new Request('http://localhost/v1/events', {
      headers: { Authorization: 'Bearer vfu_key_abc' },
    });
    expect(extractSiteKey(req1)).toBe('vfu_key_abc');

    const req2 = new Request('http://localhost/v1/events', {
      headers: { 'X-Site-Key': 'vfu_key_xyz' },
    });
    expect(extractSiteKey(req2)).toBe('vfu_key_xyz');

    const req3 = new Request('http://localhost/v1/events?api_key=vfu_query_key');
    expect(extractSiteKey(req3)).toBe('vfu_query_key');
  });

  it('validates allowed domains including subdomains and ports', () => {
    const allowed = JSON.stringify(['refreshqueue.com', 'send.refreshqueue.com', 'localhost']);

    expect(isAllowedDomain('https://refreshqueue.com', allowed)).toBe(true);
    expect(isAllowedDomain('https://app.refreshqueue.com', allowed)).toBe(true);
    expect(isAllowedDomain('http://localhost:3000', allowed)).toBe(true);
    expect(isAllowedDomain('https://malicious-site.com', allowed)).toBe(false);
  });

  it('allows all if wildcard domain or empty list configured', () => {
    expect(isAllowedDomain('https://anywhere.com', JSON.stringify(['*']))).toBe(true);
    expect(isAllowedDomain('https://anywhere.com', '[]')).toBe(true);
  });
});
