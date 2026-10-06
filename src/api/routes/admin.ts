import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { ResendEmailSender } from '../../adapters/email/resend';
import { WorkersAIProvider } from '../../adapters/ai/workers-ai';
import { PostHogConnector } from '../../adapters/analytics/posthog';
import { generateApiKey } from '../../core/auth';
import { DecisionPipeline } from '../../core/pipeline';
import { DatabaseRepository } from '../../db';
import type { Env, Site } from '../../types';

export const adminRouter = new Hono<{ Bindings: Env }>();

// Auth middleware for /admin routes
adminRouter.use('*', async (c, next) => {
  const path = c.req.path;
  if (path === '/admin/login' || path === '/admin/logout') {
    return next();
  }

  const adminPassword = c.env.ADMIN_PASSWORD;
  // If no password configured (dev mode), permit access
  if (!adminPassword) {
    return next();
  }

  const cookie = getCookie(c, 'vf_admin_auth');
  const queryToken = c.req.query('auth_token');

  if (cookie === adminPassword || queryToken === adminPassword) {
    return next();
  }

  return c.redirect('/admin/login');
});

/**
 * GET /admin/login
 */
adminRouter.get('/login', (c) => {
  return c.html(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Admin Login - Visitor Follow-Up</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: #1e293b; border-radius: 12px; padding: 32px; width: 100%; max-width: 380px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); border: 1px solid #334155; }
    h1 { font-size: 20px; font-weight: 600; margin: 0 0 8px 0; color: #f8fafc; }
    p { font-size: 13px; color: #94a3b8; margin: 0 0 24px 0; }
    input { width: 100%; padding: 10px 12px; background: #0f172a; border: 1px solid #334155; border-radius: 6px; color: #f8fafc; box-sizing: border-box; font-size: 14px; margin-bottom: 16px; }
    button { width: 100%; padding: 10px; background: #3b82f6; border: none; border-radius: 6px; color: white; font-weight: 500; cursor: pointer; font-size: 14px; }
    button:hover { background: #2563eb; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Visitor Follow-Up</h1>
    <p>Sign in to manage follow-up drafts and sites</p>
    <form method="POST" action="/admin/login">
      <input type="password" name="password" placeholder="Admin Password" required autofocus />
      <button type="submit">Sign In</button>
    </form>
  </div>
</body>
</html>
  `);
});

/**
 * POST /admin/login
 */
adminRouter.post('/login', async (c) => {
  const body = await c.req.parseBody();
  const password = String(body.password || '');
  const expectedPassword = c.env.ADMIN_PASSWORD;

  if (!expectedPassword || password === expectedPassword) {
    setCookie(c, 'vf_admin_auth', expectedPassword || 'auth', {
      path: '/admin',
      httpOnly: true,
      secure: c.env.ENVIRONMENT === 'production',
      maxAge: 60 * 60 * 24 * 7, // 7 days
    });
    return c.redirect('/admin');
  }

  return c.html(`
    <p style="color: red; text-align: center; margin-top: 50px;">Invalid password. <a href="/admin/login">Try again</a></p>
  `, 401);
});

/**
 * GET /admin/logout
 */
adminRouter.get('/logout', (c) => {
  deleteCookie(c, 'vf_admin_auth', { path: '/admin' });
  return c.redirect('/admin/login');
});

/**
 * GET /admin or /admin/drafts
 * Main Dashboard: Metrics + Pending Drafts
 */
adminRouter.get('/', async (c) => {
  const repo = new DatabaseRepository(c.env.DB);
  const sites = await repo.listSites();
  const selectedSiteId = c.req.query('site') || (sites.length > 0 ? sites[0].id : '');
  const statusFilter = (c.req.query('status') as any) || 'pending';

  const drafts = await repo.listDrafts({
    siteId: selectedSiteId || undefined,
    status: statusFilter === 'all' ? undefined : statusFilter,
    limit: 50,
  });

  const allPersons = selectedSiteId ? await repo.listPersons(selectedSiteId, 1000) : [];
  const allSends = await repo.listSends(selectedSiteId || undefined, 100);
  const allSuppressed = selectedSiteId ? await repo.listSuppression(selectedSiteId) : [];

  const selectedSite = sites.find((s) => s.id === selectedSiteId);

  return c.html(renderDashboardHtml({
    sites,
    selectedSiteId,
    selectedSite,
    drafts,
    statusFilter,
    counts: {
      pendingDrafts: drafts.filter((d) => d.status === 'pending').length,
      persons: allPersons.length,
      sends: allSends.length,
      suppressed: allSuppressed.length,
    },
  }));
});

/**
 * POST /admin/drafts/:id/approve
 * Approves and sends draft immediately
 */
adminRouter.post('/drafts/:id/approve', async (c) => {
  const id = c.req.param('id');
  const repo = new DatabaseRepository(c.env.DB);
  const emailSender = new ResendEmailSender(c.env.RESEND_API_KEY);
  const aiProvider = new WorkersAIProvider(c.env.AI, c.env.AI_MODEL);

  const pipeline = new DecisionPipeline({
    repo,
    emailSender,
    aiProvider,
    signingSecret: c.env.SIGNING_SECRET || 'secret',
    appUrl: c.env.APP_URL || 'http://localhost:8787',
  });

  let customSubject: string | undefined;
  let customBody: string | undefined;

  const contentType = c.req.header('Content-Type') || '';
  if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
    const body = await c.req.parseBody();
    if (body.subject) customSubject = String(body.subject);
    if (body.body_text) customBody = String(body.body_text);
  }

  const result = await pipeline.approveAndSendDraft(id, customSubject, customBody, 'admin');

  if (c.req.header('Accept')?.includes('application/json')) {
    return c.json(result);
  }

  return c.redirect(c.req.header('Referer') || '/admin');
});

/**
 * POST /admin/drafts/:id/reject
 * Skips or rejects draft
 */
adminRouter.post('/drafts/:id/reject', async (c) => {
  const id = c.req.param('id');
  const repo = new DatabaseRepository(c.env.DB);
  const emailSender = new ResendEmailSender(c.env.RESEND_API_KEY);
  const aiProvider = new WorkersAIProvider(c.env.AI, c.env.AI_MODEL);

  const pipeline = new DecisionPipeline({
    repo,
    emailSender,
    aiProvider,
    signingSecret: c.env.SIGNING_SECRET || 'secret',
    appUrl: c.env.APP_URL || 'http://localhost:8787',
  });

  await pipeline.rejectDraft(id, 'Skipped by admin in dashboard');

  if (c.req.header('Accept')?.includes('application/json')) {
    return c.json({ success: true });
  }

  return c.redirect(c.req.header('Referer') || '/admin');
});

/**
 * GET /admin/sites
 * Sites list & registration
 */
adminRouter.get('/sites', async (c) => {
  const repo = new DatabaseRepository(c.env.DB);
  const sites = await repo.listSites();
  return c.html(renderSitesPage(sites));
});

/**
 * POST /admin/sites
 * Create a new site
 */
adminRouter.post('/sites', async (c) => {
  const repo = new DatabaseRepository(c.env.DB);
  const body = await c.req.parseBody();

  const id = String(body.id || `site_${Date.now()}`).trim();
  const name = String(body.name || '').trim();
  const apiKey = String(body.api_key || generateApiKey()).trim();
  const senderName = String(body.sender_name || '').trim();
  const senderEmail = String(body.sender_email || '').trim();
  const replyTo = body.reply_to ? String(body.reply_to).trim() : null;
  const physicalAddress = String(body.physical_address || '').trim();

  let allowedDomains = '[]';
  if (body.allowed_domains) {
    const list = String(body.allowed_domains).split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    allowedDomains = JSON.stringify(list);
  }

  let highIntentPages = '[]';
  if (body.high_intent_pages) {
    const list = String(body.high_intent_pages).split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    highIntentPages = JSON.stringify(list);
  }

  let internalDomains = '[]';
  if (body.internal_domains) {
    const list = String(body.internal_domains).split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    internalDomains = JSON.stringify(list);
  }

  await repo.createSite({
    id,
    name,
    api_key: apiKey,
    allowed_domains: allowedDomains,
    sender_name: senderName,
    sender_email: senderEmail,
    reply_to: replyTo,
    physical_address: physicalAddress,
    go_live: body.go_live === '1' || body.go_live === 'on' ? 1 : 0,
    confidence_threshold: body.confidence_threshold ? parseFloat(String(body.confidence_threshold)) : 0.8,
    frequency_cap_days: body.frequency_cap_days ? parseInt(String(body.frequency_cap_days), 10) : 7,
    high_intent_pages: highIntentPages,
    internal_domains: internalDomains,
    prompt_template: body.prompt_template ? String(body.prompt_template) : null,
    voice_description: body.voice_description ? String(body.voice_description) : null,
    email_provider: 'resend',
    resend_api_key: body.resend_api_key ? String(body.resend_api_key) : null,
    posthog_api_key: body.posthog_api_key ? String(body.posthog_api_key) : null,
    posthog_project_id: body.posthog_project_id ? String(body.posthog_project_id) : null,
    posthog_host: body.posthog_host ? String(body.posthog_host) : 'https://us.i.posthog.com',
    webhook_url: body.webhook_url ? String(body.webhook_url) : null,
    webhook_secret: body.webhook_secret ? String(body.webhook_secret) : null,
  });

  return c.redirect('/admin/sites');
});

/**
 * POST /admin/sites/:id/toggle-live
 * Toggle go-live switch
 */
adminRouter.post('/sites/:id/toggle-live', async (c) => {
  const id = c.req.param('id');
  const repo = new DatabaseRepository(c.env.DB);
  const site = await repo.getSiteById(id);
  if (site) {
    const newGoLive = site.go_live === 1 ? 0 : 1;
    await repo.updateSite(id, { go_live: newGoLive });
    await repo.recordAuditLog(id, 'site.go_live_toggled', 'admin', { go_live: newGoLive });
  }

  return c.redirect(c.req.header('Referer') || '/admin/sites');
});

/**
 * POST /admin/sync-posthog
 * Triggers manual PostHog sync
 */
adminRouter.post('/sync-posthog', async (c) => {
  const repo = new DatabaseRepository(c.env.DB);
  const siteId = c.req.query('site');
  const sites = siteId ? [await repo.getSiteById(siteId)] : await repo.listSites();
  const connector = new PostHogConnector();
  const results: any[] = [];

  for (const s of sites) {
    if (!s || !s.posthog_api_key || !s.posthog_project_id) continue;
    const syncRes = await connector.sync({
      siteId: s.id,
      apiKey: s.posthog_api_key,
      projectId: s.posthog_project_id,
      host: s.posthog_host,
      sinceTimestamp: s.posthog_last_sync_at,
    });

    // Save synced persons and events to DB
    for (const p of syncRes.persons) {
      await repo.upsertPerson({
        siteId: s.id,
        email: p.email,
        traits: p.traits,
        emailSource: 'posthog',
        companyName: p.companyName,
        companyDomain: p.companyDomain,
      });
    }

    for (const e of syncRes.events) {
      let personId: string | null = null;
      if (e.email) {
        const found = await repo.getPersonByEmail(s.id, e.email);
        if (found) personId = found.id;
      }

      await repo.recordEvent({
        siteId: s.id,
        personId,
        anonymousId: e.distinctId,
        eventName: e.eventName,
        url: e.url,
        path: e.path,
        referrer: e.referrer,
        durationSeconds: e.durationSeconds,
        properties: e.properties,
        timestamp: e.timestamp,
      });
    }

    if (syncRes.newCursor) {
      await repo.updateSite(s.id, { posthog_last_sync_at: syncRes.newCursor } as any);
    }

    await repo.recordAuditLog(s.id, 'sync.posthog', 'admin', {
      personsDiscovered: syncRes.persons.length,
      eventsDiscovered: syncRes.events.length,
      errors: syncRes.errors,
    });

    results.push({ site: s.id, syncRes });
  }

  if (c.req.header('Accept')?.includes('application/json')) {
    return c.json({ success: true, results });
  }

  return c.redirect(c.req.header('Referer') || '/admin');
});

/**
 * POST /admin/run-pipeline
 * Triggers manual evaluation of candidates with new activity
 */
adminRouter.post('/run-pipeline', async (c) => {
  const repo = new DatabaseRepository(c.env.DB);
  const emailSender = new ResendEmailSender(c.env.RESEND_API_KEY);
  const aiProvider = new WorkersAIProvider(c.env.AI, c.env.AI_MODEL);

  const pipeline = new DecisionPipeline({
    repo,
    emailSender,
    aiProvider,
    signingSecret: c.env.SIGNING_SECRET || 'secret',
    appUrl: c.env.APP_URL || 'http://localhost:8787',
  });

  const siteId = c.req.query('site');
  const sites = siteId ? [await repo.getSiteById(siteId)] : await repo.listSites();
  const summary: any[] = [];

  for (const s of sites) {
    if (!s) continue;
    const res = await pipeline.processSite(s);
    summary.push({ site: s.id, ...res });
  }

  if (c.req.header('Accept')?.includes('application/json')) {
    return c.json({ success: true, summary });
  }

  return c.redirect(c.req.header('Referer') || '/admin');
});

/**
 * GET /admin/persons
 */
adminRouter.get('/persons', async (c) => {
  const repo = new DatabaseRepository(c.env.DB);
  const sites = await repo.listSites();
  const selectedSiteId = c.req.query('site') || (sites.length > 0 ? sites[0].id : '');
  const persons = selectedSiteId ? await repo.listPersons(selectedSiteId, 100) : [];
  const suppressed = selectedSiteId ? await repo.listSuppression(selectedSiteId) : [];
  const suppressedEmails = new Set(suppressed.map((s) => s.email.toLowerCase()));

  return c.html(renderPersonsPage({ sites, selectedSiteId, persons, suppressedEmails }));
});

/**
 * GET /admin/logs
 */
adminRouter.get('/logs', async (c) => {
  const repo = new DatabaseRepository(c.env.DB);
  const sites = await repo.listSites();
  const selectedSiteId = c.req.query('site') || '';
  const auditLogs = await repo.listAuditLogs(selectedSiteId || undefined, 100);
  const sends = await repo.listSends(selectedSiteId || undefined, 100);

  return c.html(renderLogsPage({ sites, selectedSiteId, auditLogs, sends }));
});

// HTML Rendering Helpers
function renderLayout(title: string, activeTab: string, content: string, selectedSiteId = ''): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} - Visitor Follow-Up</title>
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --border: #334155;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --primary: #3b82f6;
      --primary-hover: #2563eb;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
    }
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 0; min-height: 100vh; }
    header { background: var(--card-bg); border-bottom: 1px solid var(--border); padding: 14px 24px; display: flex; align-items: center; justify-content: space-between; }
    .brand { font-size: 18px; font-weight: 700; color: var(--text); text-decoration: none; display: flex; align-items: center; gap: 8px; }
    .brand span { color: var(--primary); }
    nav { display: flex; gap: 6px; }
    nav a { color: var(--text-muted); text-decoration: none; padding: 6px 14px; border-radius: 6px; font-size: 14px; font-weight: 500; transition: all 0.15s; }
    nav a.active, nav a:hover { color: var(--text); background: rgba(255,255,255,0.08); }
    .header-actions { display: flex; align-items: center; gap: 12px; }
    .main { max-width: 1200px; margin: 0 auto; padding: 24px; }
    .card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 10px; padding: 20px; margin-bottom: 20px; }
    .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .metric-card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 10px; padding: 18px; }
    .metric-val { font-size: 28px; font-weight: 700; color: var(--text); margin-top: 4px; }
    .metric-label { font-size: 13px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
    .badge { display: inline-block; padding: 3px 8px; border-radius: 9999px; font-size: 11px; font-weight: 600; text-transform: uppercase; }
    .badge-success { background: rgba(16, 185, 129, 0.2); color: #34d399; }
    .badge-warning { background: rgba(245, 158, 11, 0.2); color: #fbbf24; }
    .badge-danger { background: rgba(239, 68, 68, 0.2); color: #f87171; }
    .badge-info { background: rgba(59, 130, 246, 0.2); color: #60a5fa; }
    button, .btn { padding: 8px 14px; border-radius: 6px; border: none; font-size: 13px; font-weight: 500; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; gap: 6px; }
    .btn-primary { background: var(--primary); color: white; }
    .btn-primary:hover { background: var(--primary-hover); }
    .btn-success { background: var(--success); color: white; }
    .btn-danger { background: var(--danger); color: white; }
    .btn-secondary { background: rgba(255,255,255,0.08); color: var(--text); border: 1px solid var(--border); }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 14px; }
    th { text-align: left; padding: 10px 12px; color: var(--text-muted); border-bottom: 1px solid var(--border); font-weight: 600; font-size: 12px; text-transform: uppercase; }
    td { padding: 12px; border-bottom: 1px solid rgba(255,255,255,0.04); vertical-align: top; }
    tr:hover td { background: rgba(255,255,255,0.02); }
    pre { background: #0b1120; padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 12px; color: #cbd5e1; }
    .form-group { margin-bottom: 16px; }
    label { display: block; font-size: 13px; font-weight: 500; margin-bottom: 6px; color: #cbd5e1; }
    input, textarea, select { width: 100%; padding: 8px 12px; background: #0f172a; border: 1px solid var(--border); border-radius: 6px; color: var(--text); font-size: 14px; }
    textarea { min-height: 80px; font-family: inherit; }
  </style>
</head>
<body>
  <header>
    <a href="/admin" class="brand">🚀 <span>Visitor Follow-Up</span></a>
    <nav>
      <a href="/admin?site=${selectedSiteId}" class="${activeTab === 'drafts' ? 'active' : ''}">Drafts</a>
      <a href="/admin/sites" class="${activeTab === 'sites' ? 'active' : ''}">Sites</a>
      <a href="/admin/persons?site=${selectedSiteId}" class="${activeTab === 'persons' ? 'active' : ''}">Visitors</a>
      <a href="/admin/logs?site=${selectedSiteId}" class="${activeTab === 'logs' ? 'active' : ''}">Logs</a>
    </nav>
    <div class="header-actions">
      <a href="/admin/logout" class="btn btn-secondary" style="padding: 5px 10px; font-size: 12px;">Sign Out</a>
    </div>
  </header>
  <div class="main">
    ${content}
  </div>
</body>
</html>
  `;
}

function renderDashboardHtml(data: any): string {
  const { sites, selectedSiteId, selectedSite, drafts, statusFilter, counts } = data;

  const siteOptions = sites
    .map((s: Site) => `<option value="${s.id}" ${s.id === selectedSiteId ? 'selected' : ''}>${s.name} (${s.id})</option>`)
    .join('');

  const draftsHtml = drafts.length === 0
    ? `<div style="text-align: center; padding: 40px; color: var(--text-muted);">No drafts found with status "${statusFilter}".</div>`
    : drafts.map((d: any) => `
      <div class="card" style="margin-bottom: 16px; border-left: 4px solid ${d.status === 'sent' ? 'var(--success)' : d.status === 'skipped' ? 'var(--text-muted)' : 'var(--primary)'};">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 10px;">
          <div>
            <span class="badge ${d.status === 'sent' ? 'badge-success' : d.status === 'pending' ? 'badge-info' : 'badge-warning'}">${d.status}</span>
            <span class="badge badge-info" style="margin-left: 6px;">AI Confidence: ${Math.round((d.ai_confidence || 0) * 100)}%</span>
            ${d.ai_persona ? `<span class="badge" style="background: rgba(147, 51, 234, 0.2); color: #c084fc; margin-left: 6px;">${escapeHtml(d.ai_persona)}</span>` : ''}
            <div style="font-size: 16px; font-weight: 600; margin-top: 6px; color: #f8fafc;">${escapeHtml(d.subject)}</div>
          </div>
          <div style="font-size: 12px; color: var(--text-muted);">${new Date(d.created_at).toLocaleString()}</div>
        </div>

        <div style="font-size: 13px; color: #94a3b8; margin-bottom: 12px; background: rgba(0,0,0,0.2); padding: 8px 12px; border-radius: 6px;">
          <strong>AI Reasoning:</strong> ${escapeHtml(d.ai_reason)}<br/>
          ${d.activity_summary ? `<strong>Activity:</strong> ${escapeHtml(d.activity_summary)}` : ''}
        </div>

        <div style="background: #090d16; padding: 12px; border-radius: 6px; font-family: monospace; font-size: 13px; white-space: pre-wrap; line-height: 1.5; color: #e2e8f0; border: 1px solid rgba(255,255,255,0.06);">
${escapeHtml(d.body_text)}
        </div>

        ${d.status === 'pending' ? `
          <div style="margin-top: 14px; display: flex; gap: 8px; justify-content: flex-end;">
            <form method="POST" action="/admin/drafts/${d.id}/reject">
              <button type="submit" class="btn btn-secondary">Skip / Discard</button>
            </form>
            <form method="POST" action="/admin/drafts/${d.id}/approve">
              <button type="submit" class="btn btn-success">✓ Approve & Send Now</button>
            </form>
          </div>
        ` : ''}
      </div>
    `).join('');

  return renderLayout(
    'Dashboard',
    'drafts',
    `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
      <div style="display: flex; align-items: center; gap: 12px;">
        <label style="margin: 0; font-size: 14px; color: var(--text-muted);">Site:</label>
        <select onchange="window.location.href='/admin?site='+this.value" style="width: 220px;">
          ${siteOptions || '<option value="">No sites registered</option>'}
        </select>
        ${selectedSite ? `
          <form method="POST" action="/admin/sites/${selectedSite.id}/toggle-live" style="margin: 0;">
            <button type="submit" class="btn ${selectedSite.go_live ? 'btn-success' : 'btn-secondary'}" style="padding: 6px 12px; font-size: 12px;">
              Go-Live: ${selectedSite.go_live ? '🟢 ON (Auto-Send)' : '⚪ OFF (Drafts Only)'}
            </button>
          </form>
        ` : ''}
      </div>
      <div style="display: flex; gap: 8px;">
        <form method="POST" action="/admin/sync-posthog?site=${selectedSiteId}" style="margin: 0;">
          <button type="submit" class="btn btn-secondary">↻ Sync PostHog</button>
        </form>
        <form method="POST" action="/admin/run-pipeline?site=${selectedSiteId}" style="margin: 0;">
          <button type="submit" class="btn btn-primary">⚡ Run Pipeline</button>
        </form>
      </div>
    </div>

    <div class="metrics">
      <div class="metric-card">
        <div class="metric-label">Pending Drafts</div>
        <div class="metric-val" style="color: #60a5fa;">${counts.pendingDrafts}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Emails Sent</div>
        <div class="metric-val" style="color: #34d399;">${counts.sends}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Identified Persons</div>
        <div class="metric-val">${counts.persons}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Suppressed</div>
        <div class="metric-val" style="color: #f87171;">${counts.suppressed}</div>
      </div>
    </div>

    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
      <h2 style="font-size: 18px; margin: 0;">Drafts & Review Queue</h2>
      <div style="display: flex; gap: 6px;">
        <a href="/admin?site=${selectedSiteId}&status=pending" class="btn ${statusFilter === 'pending' ? 'btn-primary' : 'btn-secondary'}" style="padding: 5px 10px; font-size: 12px;">Pending</a>
        <a href="/admin?site=${selectedSiteId}&status=sent" class="btn ${statusFilter === 'sent' ? 'btn-primary' : 'btn-secondary'}" style="padding: 5px 10px; font-size: 12px;">Sent</a>
        <a href="/admin?site=${selectedSiteId}&status=skipped" class="btn ${statusFilter === 'skipped' ? 'btn-primary' : 'btn-secondary'}" style="padding: 5px 10px; font-size: 12px;">Skipped</a>
        <a href="/admin?site=${selectedSiteId}&status=all" class="btn ${statusFilter === 'all' ? 'btn-primary' : 'btn-secondary'}" style="padding: 5px 10px; font-size: 12px;">All</a>
      </div>
    </div>

    ${draftsHtml}
    `,
    selectedSiteId
  );
}

function renderSitesPage(sites: Site[]): string {
  const sitesList = sites.map((s) => `
    <tr>
      <td>
        <strong>${escapeHtml(s.name)}</strong><br/>
        <code style="font-size: 11px; color: var(--text-muted);">${escapeHtml(s.id)}</code>
      </td>
      <td>
        <form method="POST" action="/admin/sites/${s.id}/toggle-live" style="margin: 0;">
          <button type="submit" class="badge ${s.go_live ? 'badge-success' : 'badge-warning'}" style="cursor: pointer; border: none;">
            ${s.go_live ? '🟢 LIVE' : '⚪ DRAFTS ONLY'}
          </button>
        </form>
      </td>
      <td>
        ${escapeHtml(s.sender_name)} &lt;${escapeHtml(s.sender_email)}&gt;
      </td>
      <td>
        Cap: ${s.frequency_cap_days}d<br/>
        Threshold: ${Math.round(s.confidence_threshold * 100)}%
      </td>
      <td>
        <input type="text" readonly value="${escapeHtml(s.api_key)}" style="font-size: 11px; padding: 4px 6px; width: 170px;" onclick="this.select()" />
      </td>
    </tr>
  `).join('');

  return renderLayout(
    'Sites',
    'sites',
    `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
      <h2 style="font-size: 20px; margin: 0;">Registered Sites ("Sources")</h2>
    </div>

    <div class="card">
      <h3 style="margin-top: 0; font-size: 16px;">Connected Sites</h3>
      <table>
        <thead>
          <tr>
            <th>Site</th>
            <th>Mode</th>
            <th>Sender Identity</th>
            <th>Rules</th>
            <th>API Key</th>
          </tr>
        </thead>
        <tbody>
          ${sitesList || '<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">No sites registered yet. Register your first site below.</td></tr>'}
        </tbody>
      </table>
    </div>

    <div class="card">
      <h3 style="margin-top: 0; font-size: 16px;">Register New Site</h3>
      <form method="POST" action="/admin/sites">
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
          <div class="form-group">
            <label>Site ID (e.g. sales-coach)</label>
            <input type="text" name="id" required placeholder="sales-coach" />
          </div>
          <div class="form-group">
            <label>Site Name</label>
            <input type="text" name="name" required placeholder="Sales Coach" />
          </div>
          <div class="form-group">
            <label>Sender Name</label>
            <input type="text" name="sender_name" required placeholder="Yehuda" />
          </div>
          <div class="form-group">
            <label>Sender Email</label>
            <input type="email" name="sender_email" required placeholder="yehuda@refreshqueue.com" />
          </div>
          <div class="form-group">
            <label>Reply-To Email (optional)</label>
            <input type="email" name="reply_to" placeholder="hello@refreshqueue.com" />
          </div>
          <div class="form-group">
            <label>Physical Address (CAN-SPAM footer)</label>
            <input type="text" name="physical_address" required placeholder="Sales Coach, 123 Tech Way, Suite 100, City, ST 12345" />
          </div>
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
          <div class="form-group">
            <label>Allowed Domains (comma-separated)</label>
            <input type="text" name="allowed_domains" placeholder="refreshqueue.com, send.refreshqueue.com, localhost" />
          </div>
          <div class="form-group">
            <label>Internal Domains to Skip (comma-separated)</label>
            <input type="text" name="internal_domains" placeholder="refreshqueue.com" />
          </div>
          <div class="form-group">
            <label>High-Intent Page Paths (comma-separated)</label>
            <input type="text" name="high_intent_pages" placeholder="/, /#pricing, /integrations, /app/sign-up" />
          </div>
          <div class="form-group">
            <label>Frequency Cap (days, default 7)</label>
            <input type="number" name="frequency_cap_days" value="7" min="1" />
          </div>
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px;">
          <div class="form-group">
            <label>Resend API Key (optional override)</label>
            <input type="password" name="resend_api_key" placeholder="re_..." />
          </div>
          <div class="form-group">
            <label>PostHog Personal API Key</label>
            <input type="password" name="posthog_api_key" placeholder="phx_..." />
          </div>
          <div class="form-group">
            <label>PostHog Project ID</label>
            <input type="text" name="posthog_project_id" placeholder="645997" />
          </div>
        </div>

        <div class="form-group">
          <label>Custom Prompt Template / Voice Instructions</label>
          <textarea name="prompt_template" placeholder="Tone: direct founder tone, plain text under 120 words. Focus on integrations and ROI."></textarea>
        </div>

        <div style="display: flex; gap: 16px; align-items: center; margin-top: 8px;">
          <label style="display: flex; align-items: center; gap: 8px; margin: 0; cursor: pointer;">
            <input type="checkbox" name="go_live" value="1" style="width: auto;" />
            Go-Live immediately (auto-send high confidence)
          </label>
          <button type="submit" class="btn btn-primary" style="margin-left: auto;">+ Register Site</button>
        </div>
      </form>
    </div>
    `
  );
}

function renderPersonsPage(data: any): string {
  const { sites, selectedSiteId, persons, suppressedEmails } = data;
  const siteOptions = sites
    .map((s: Site) => `<option value="${s.id}" ${s.id === selectedSiteId ? 'selected' : ''}>${s.name}</option>`)
    .join('');

  const rows = persons.map((p: any) => `
    <tr>
      <td>
        <strong>${escapeHtml(p.email)}</strong><br/>
        <span style="font-size: 11px; color: var(--text-muted);">${escapeHtml(p.email_source)}</span>
      </td>
      <td>${escapeHtml(p.company_name || '—')}</td>
      <td>
        <span class="badge ${p.is_customer ? 'badge-success' : 'badge-info'}">
          ${p.is_customer ? 'Customer / Paid' : 'Lead'}
        </span>
      </td>
      <td>
        ${suppressedEmails.has(p.email.toLowerCase())
          ? '<span class="badge badge-danger">Suppressed</span>'
          : '<span class="badge badge-success">Subscribed</span>'}
      </td>
      <td>${p.last_emailed_at ? new Date(p.last_emailed_at).toLocaleDateString() : 'Never'}</td>
      <td>${new Date(p.last_seen_at).toLocaleDateString()}</td>
    </tr>
  `).join('');

  return renderLayout(
    'Visitors',
    'persons',
    `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
      <h2 style="font-size: 20px; margin: 0;">Identified Visitors</h2>
      <select onchange="window.location.href='/admin/persons?site='+this.value" style="width: 220px;">
        ${siteOptions}
      </select>
    </div>

    <div class="card">
      <table>
        <thead>
          <tr>
            <th>Email / Source</th>
            <th>Company</th>
            <th>Customer Status</th>
            <th>Suppression</th>
            <th>Last Emailed</th>
            <th>Last Seen</th>
          </tr>
        </thead>
        <tbody>
          ${rows || '<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">No identified visitors yet.</td></tr>'}
        </tbody>
      </table>
    </div>
    `,
    selectedSiteId
  );
}

function renderLogsPage(data: any): string {
  const { sites, selectedSiteId, auditLogs, sends } = data;
  const siteOptions = sites
    .map((s: Site) => `<option value="${s.id}" ${s.id === selectedSiteId ? 'selected' : ''}>${s.name}</option>`)
    .join('');

  const logRows = auditLogs.map((l: any) => `
    <tr>
      <td><span class="badge badge-info">${escapeHtml(l.action)}</span></td>
      <td>${escapeHtml(l.actor)}</td>
      <td><code style="font-size: 11px;">${escapeHtml(l.details)}</code></td>
      <td>${new Date(l.created_at).toLocaleString()}</td>
    </tr>
  `).join('');

  return renderLayout(
    'Logs',
    'logs',
    `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
      <h2 style="font-size: 20px; margin: 0;">Audit & Send Activity</h2>
      <select onchange="window.location.href='/admin/logs?site='+this.value" style="width: 220px;">
        <option value="">All Sites</option>
        ${siteOptions}
      </select>
    </div>

    <div class="card">
      <h3 style="margin-top: 0; font-size: 16px;">Audit Trail</h3>
      <table>
        <thead>
          <tr>
            <th>Action</th>
            <th>Actor</th>
            <th>Details</th>
            <th>Timestamp</th>
          </tr>
        </thead>
        <tbody>
          ${logRows || '<tr><td colspan="4" style="text-align: center; color: var(--text-muted);">No activity logged yet.</td></tr>'}
        </tbody>
      </table>
    </div>
    `,
    selectedSiteId
  );
}

function escapeHtml(str: string | null | undefined): string {
  if (!str) return '';
  return String(str).replace(/[&<>"']/g, (m) => {
    switch (m) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return m;
    }
  });
}
