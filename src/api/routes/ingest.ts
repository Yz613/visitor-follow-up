import { Hono } from 'hono';
import { extractSiteKey, isAllowedDomain } from '../../core/auth';
import { DatabaseRepository } from '../../db';
import type { Env, Site } from '../../types';

export const ingestRouter = new Hono<{ Bindings: Env }>();

// Helper to authenticate site from either API key or allowed browser origin
async function resolveSite(
  c: any,
  repo: DatabaseRepository,
  bodySiteId?: string
): Promise<{ site: Site | null; error?: string; status?: number }> {
  const req = c.req.raw as Request;
  const siteKey = extractSiteKey(req);

  if (siteKey) {
    const site = await repo.getSiteByApiKey(siteKey);
    if (site) {
      if (bodySiteId && bodySiteId !== site.id) {
        return { site: null, error: 'Site ID does not match API Key', status: 403 };
      }
      return { site };
    }
  }

  // If no valid API key was found, check if a site_id was provided (e.g. from browser snippet)
  if (bodySiteId) {
    const site = await repo.getSiteById(bodySiteId);
    if (site) {
      const origin = req.headers.get('Origin') || req.headers.get('Referer');
      if (isAllowedDomain(origin, site.allowed_domains)) {
        return { site };
      }
      return { site: null, error: `Origin '${origin}' not authorized for site ${bodySiteId}`, status: 403 };
    }
    return { site: null, error: `Site '${bodySiteId}' not found`, status: 404 };
  }

  return { site: null, error: 'Unauthorized: missing or invalid API Key / Site ID', status: 401 };
}

/**
 * POST /v1/identify
 * Identify a visitor with their email address, optional traits, and company info
 */
ingestRouter.post('/identify', async (c) => {
  const repo = new DatabaseRepository(c.env.DB);
  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { site, error, status } = await resolveSite(c, repo, body.site_id);
  if (!site) return c.json({ error }, (status as any) || 401);

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email || !email.includes('@')) {
    return c.json({ error: 'Valid email is required to identify a visitor' }, 400);
  }

  const person = await repo.upsertPerson({
    siteId: site.id,
    email,
    traits: typeof body.traits === 'object' ? body.traits : {},
    emailSource: body.email_source || 'api_identify',
    companyName: body.company || body.company_name || null,
    companyDomain: body.company_domain || null,
    notes: body.notes || null,
    isCustomer: typeof body.is_customer === 'boolean' ? body.is_customer : undefined,
  });

  // If an anonymous ID was provided, link earlier visits to this identified person
  if (body.anonymous_id && typeof body.anonymous_id === 'string') {
    await repo.linkAnonymousEvents(site.id, body.anonymous_id, person.id);
  }

  return c.json({
    success: true,
    site_id: site.id,
    person_id: person.id,
    email: person.email,
  });
});

/**
 * POST /v1/events
 * Track an event (page view, feature clicked, form started, etc.)
 */
ingestRouter.post('/events', async (c) => {
  const repo = new DatabaseRepository(c.env.DB);
  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { site, error, status } = await resolveSite(c, repo, body.site_id);
  if (!site) return c.json({ error }, (status as any) || 401);

  const eventName = body.event || body.event_name || 'event';
  let personId: string | null = null;

  // If email is provided with the event, lookup person
  if (body.email && typeof body.email === 'string') {
    const person = await repo.getPersonByEmail(site.id, body.email);
    if (person) personId = person.id;
  }

  const recorded = await repo.recordEvent({
    siteId: site.id,
    personId,
    anonymousId: body.anonymous_id || null,
    eventName,
    url: body.url || null,
    path: body.path || null,
    referrer: body.referrer || null,
    durationSeconds: typeof body.duration_seconds === 'number' ? body.duration_seconds : 0,
    properties: typeof body.properties === 'object' ? body.properties : {},
    timestamp: body.timestamp || new Date().toISOString(),
  });

  return c.json({
    success: true,
    event_id: recorded.id,
    site_id: site.id,
  });
});

/**
 * POST /v1/conversions
 * Report conversions: e.g. checkout started, checkout paid, workspace created
 */
ingestRouter.post('/conversions', async (c) => {
  const repo = new DatabaseRepository(c.env.DB);
  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { site, error, status } = await resolveSite(c, repo, body.site_id);
  if (!site) return c.json({ error }, (status as any) || 401);

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email || !email.includes('@')) {
    return c.json({ error: 'Valid email is required to record a conversion' }, 400);
  }

  const conversionType = body.conversion_type || 'conversion';
  const isCustomer = body.is_customer !== false; // Default true for paid conversions

  let person = await repo.getPersonByEmail(site.id, email);
  if (!person) {
    person = await repo.upsertPerson({
      siteId: site.id,
      email,
      emailSource: `conversion:${conversionType}`,
      isCustomer,
    });
  } else if (isCustomer) {
    await repo.markCustomer(site.id, email, true);
  }

  // Record conversion event
  await repo.recordEvent({
    siteId: site.id,
    personId: person.id,
    eventName: `conversion:${conversionType}`,
    properties: {
      amount: body.amount,
      currency: body.currency,
      ...(typeof body.properties === 'object' ? body.properties : {}),
    },
  });

  return c.json({
    success: true,
    site_id: site.id,
    email,
    is_customer: isCustomer,
  });
});
