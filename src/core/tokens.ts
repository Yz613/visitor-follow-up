// Web Crypto based HMAC-SHA256 token generator and validator

async function getHmacKey(secret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

function bufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Generates an HMAC-SHA256 signature for unsubscribe links
 */
export async function generateUnsubscribeToken(
  siteId: string,
  email: string,
  secret: string
): Promise<string> {
  const key = await getHmacKey(secret);
  const data = new TextEncoder().encode(`${siteId.trim()}:${email.trim().toLowerCase()}`);
  const signature = await crypto.subtle.sign('HMAC', key, data);
  return bufferToHex(signature);
}

/**
 * Verifies an unsubscribe token signature
 */
export async function verifyUnsubscribeToken(
  token: string,
  siteId: string,
  email: string,
  secret: string
): Promise<boolean> {
  if (!token || !siteId || !email || !secret) return false;
  try {
    const expected = await generateUnsubscribeToken(siteId, email, secret);
    return timingSafeEqual(token.toLowerCase(), expected.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Builds the complete one-click unsubscribe URL
 */
export async function buildUnsubscribeUrl(
  baseUrl: string,
  siteId: string,
  email: string,
  secret: string
): Promise<string> {
  const token = await generateUnsubscribeToken(siteId, email, secret);
  const cleanBase = (baseUrl || 'http://localhost:8787').replace(/\/+$/, '');
  const url = new URL(`${cleanBase}/unsubscribe`);
  url.searchParams.set('site', siteId);
  url.searchParams.set('email', email.trim().toLowerCase());
  url.searchParams.set('token', token);
  return url.toString();
}

/**
 * Timing-safe string comparison to prevent timing attacks
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
