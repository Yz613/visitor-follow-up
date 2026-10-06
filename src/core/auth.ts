import type { Site } from '../types';

export function generateApiKey(prefix = 'vfu_live_'): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return `${prefix}${hex}`;
}

export function extractBearerToken(authHeader?: string | null): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

export function extractSiteKey(request: Request): string | null {
  const authHeader = request.headers.get('Authorization');
  const bearer = extractBearerToken(authHeader);
  if (bearer) return bearer;

  const headerKey = request.headers.get('X-Site-Key');
  if (headerKey) return headerKey.trim();

  // Also support query param for testing / webhook convenience
  const url = new URL(request.url);
  const queryKey = url.searchParams.get('api_key') || url.searchParams.get('apiKey');
  return queryKey ? queryKey.trim() : null;
}

/**
 * Validates whether the incoming Origin or Referer matches the site's allowed_domains
 */
export function isAllowedDomain(originOrReferer: string | null, allowedDomainsJson: string): boolean {
  if (!originOrReferer) return true; // Server-to-server calls often have no origin
  try {
    const allowed: string[] = JSON.parse(allowedDomainsJson || '[]');
    if (allowed.length === 0 || allowed.includes('*')) return true;

    let host = originOrReferer;
    try {
      const url = new URL(originOrReferer);
      host = url.hostname;
    } catch {
      // already a hostname or string
    }

    const hostLower = host.toLowerCase();
    return allowed.some((d) => {
      const clean = d.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
      return hostLower === clean || hostLower.endsWith('.' + clean);
    });
  } catch {
    return true;
  }
}
