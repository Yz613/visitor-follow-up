import { describe, expect, it } from 'vitest';
import { buildUnsubscribeUrl, generateUnsubscribeToken, verifyUnsubscribeToken } from '../src/core/tokens';

describe('Unsubscribe Token Engine', () => {
  const secret = 'super-secret-cryptographic-key-12345';
  const siteId = 'sales-coach';
  const email = 'prospect@acmecorp.com';

  it('generates a deterministic HMAC-SHA256 signature', async () => {
    const token1 = await generateUnsubscribeToken(siteId, email, secret);
    const token2 = await generateUnsubscribeToken(siteId, email, secret);

    expect(token1).toBeTruthy();
    expect(typeof token1).toBe('string');
    expect(token1).toHaveLength(64); // SHA-256 hex length
    expect(token1).toBe(token2);
  });

  it('verifies valid token for matching site, email, and secret', async () => {
    const token = await generateUnsubscribeToken(siteId, email, secret);
    const isValid = await verifyUnsubscribeToken(token, siteId, email, secret);
    expect(isValid).toBe(true);
  });

  it('normalizes email casing and whitespace during verification', async () => {
    const token = await generateUnsubscribeToken(siteId, email, secret);
    const isValid = await verifyUnsubscribeToken(token, siteId, '  PROSPECT@AcmeCorp.com  ', secret);
    expect(isValid).toBe(true);
  });

  it('rejects tampered email addresses', async () => {
    const token = await generateUnsubscribeToken(siteId, email, secret);
    const isValid = await verifyUnsubscribeToken(token, siteId, 'different@acmecorp.com', secret);
    expect(isValid).toBe(false);
  });

  it('rejects tampered site IDs', async () => {
    const token = await generateUnsubscribeToken(siteId, email, secret);
    const isValid = await verifyUnsubscribeToken(token, 'other-site', email, secret);
    expect(isValid).toBe(false);
  });

  it('rejects forged or modified tokens', async () => {
    const token = await generateUnsubscribeToken(siteId, email, secret);
    const modifiedToken = token.slice(0, -2) + 'aa';
    const isValid = await verifyUnsubscribeToken(modifiedToken, siteId, email, secret);
    expect(isValid).toBe(false);
  });

  it('rejects when secret differs', async () => {
    const token = await generateUnsubscribeToken(siteId, email, secret);
    const isValid = await verifyUnsubscribeToken(token, siteId, email, 'different-secret-key');
    expect(isValid).toBe(false);
  });

  it('builds a well-formed unsubscribe URL with parameters', async () => {
    const urlString = await buildUnsubscribeUrl('https://followup.example.com', siteId, email, secret);
    const url = new URL(urlString);

    expect(url.origin).toBe('https://followup.example.com');
    expect(url.pathname).toBe('/unsubscribe');
    expect(url.searchParams.get('site')).toBe(siteId);
    expect(url.searchParams.get('email')).toBe(email);
    expect(url.searchParams.get('token')).toBeTruthy();

    const verified = await verifyUnsubscribeToken(
      url.searchParams.get('token')!,
      url.searchParams.get('site')!,
      url.searchParams.get('email')!,
      secret
    );
    expect(verified).toBe(true);
  });
});
