import { Hono } from 'hono';
import { verifyUnsubscribeToken } from '../../core/tokens';
import { dispatchWebhook } from '../../core/webhooks';
import { DatabaseRepository } from '../../db';
import type { Env } from '../../types';

export const unsubscribeRouter = new Hono<{ Bindings: Env }>();

/**
 * GET /unsubscribe
 * Renders the unsubscribe confirmation form or directly processes if verified
 */
unsubscribeRouter.get('/', async (c) => {
  const siteId = c.req.query('site') || '';
  const email = c.req.query('email') || '';
  const token = c.req.query('token') || '';
  const secret = c.env.SIGNING_SECRET || 'default-secret-change-in-production';

  if (!siteId || !email || !token) {
    return c.html(renderMessagePage('Invalid Link', 'Missing required parameters for unsubscribe link.', false), 400);
  }

  const isValid = await verifyUnsubscribeToken(token, siteId, email, secret);
  if (!isValid) {
    return c.html(renderMessagePage('Invalid Link', 'This unsubscribe link is invalid or has expired.', false), 403);
  }

  const repo = new DatabaseRepository(c.env.DB);
  const site = await repo.getSiteById(siteId);
  const siteName = site?.name || 'this service';

  // Render clean confirmation form
  return c.html(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Unsubscribe from ${siteName}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8fafc; color: #1e293b; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
    .card { background: white; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.08); padding: 32px; max-width: 440px; width: 100%; text-align: center; border: 1px solid #e2e8f0; }
    h1 { font-size: 20px; font-weight: 600; margin-bottom: 8px; color: #0f172a; }
    p { font-size: 14px; color: #64748b; line-height: 1.5; margin-bottom: 24px; }
    .email-badge { background: #f1f5f9; padding: 4px 10px; border-radius: 6px; font-weight: 500; color: #334155; }
    button { background: #ef4444; color: white; border: none; padding: 12px 24px; font-size: 14px; font-weight: 500; border-radius: 8px; cursor: pointer; transition: background 0.15s; width: 100%; }
    button:hover { background: #dc2626; }
    .footer { margin-top: 20px; font-size: 12px; color: #94a3b8; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Unsubscribe Confirmation</h1>
    <p>Please confirm that you want to unsubscribe <span class="email-badge">${escapeHtml(email)}</span> from follow-up emails from <strong>${escapeHtml(siteName)}</strong>.</p>
    <form method="POST" action="/unsubscribe">
      <input type="hidden" name="site" value="${escapeHtml(siteId)}" />
      <input type="hidden" name="email" value="${escapeHtml(email)}" />
      <input type="hidden" name="token" value="${escapeHtml(token)}" />
      <button type="submit">Unsubscribe Me</button>
    </form>
    <div class="footer">One-click unsubscribe complies with CAN-SPAM regulations.</div>
  </div>
</body>
</html>
  `);
});

/**
 * POST /unsubscribe
 * Handles unsubscribe form submission or RFC 8058 One-Click List-Unsubscribe
 */
unsubscribeRouter.post('/', async (c) => {
  let siteId = c.req.query('site') || '';
  let email = c.req.query('email') || '';
  let token = c.req.query('token') || '';

  // Parse body if posted via form or json
  const contentType = c.req.header('Content-Type') || '';
  if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
    const formData = await c.req.parseBody();
    if (formData.site) siteId = String(formData.site);
    if (formData.email) email = String(formData.email);
    if (formData.token) token = String(formData.token);
  } else if (contentType.includes('application/json')) {
    const json = await c.req.json().catch(() => ({}));
    if (json.site) siteId = String(json.site);
    if (json.email) email = String(json.email);
    if (json.token) token = String(json.token);
  }

  const secret = c.env.SIGNING_SECRET || 'default-secret-change-in-production';
  const isValid = await verifyUnsubscribeToken(token, siteId, email, secret);

  if (!isValid) {
    if (c.req.header('Accept')?.includes('application/json')) {
      return c.json({ success: false, error: 'Invalid or expired unsubscribe token' }, 403);
    }
    return c.html(renderMessagePage('Error', 'Invalid or expired unsubscribe token.', false), 403);
  }

  const repo = new DatabaseRepository(c.env.DB);
  const site = await repo.getSiteById(siteId);

  // 1. Add to suppression list
  await repo.addSuppression(siteId, email, 'unsubscribe_link');

  // 2. Audit log
  await repo.recordAuditLog(siteId, 'person.unsubscribed', 'user', { email });

  // 3. Dispatch outbound webhook
  if (site) {
    await dispatchWebhook(site.webhook_url, site.webhook_secret, {
      event: 'person.unsubscribed',
      siteId,
      timestamp: new Date().toISOString(),
      data: { email, reason: 'unsubscribe_link' },
    });
  }

  if (c.req.header('Accept')?.includes('application/json')) {
    return c.json({ success: true, unsubscribed: true, email });
  }

  return c.html(
    renderMessagePage(
      'Unsubscribed Successfully',
      `You have been removed from future follow-up emails for ${site?.name || 'this site'}. You won't hear from us again.`,
      true
    )
  );
});

function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, (m) => {
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

function renderMessagePage(title: string, message: string, isSuccess: boolean): string {
  const icon = isSuccess ? '✓' : '⚠';
  const iconColor = isSuccess ? '#16a34a' : '#ef4444';
  const iconBg = isSuccess ? '#dcfce7' : '#fee2e2';

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8fafc; color: #1e293b; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
    .card { background: white; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.08); padding: 32px; max-width: 440px; width: 100%; text-align: center; border: 1px solid #e2e8f0; }
    .icon { width: 48px; height: 48px; border-radius: 50%; background: ${iconBg}; color: ${iconColor}; display: flex; align-items: center; justify-content: center; font-size: 24px; font-weight: bold; margin: 0 auto 16px; }
    h1 { font-size: 20px; font-weight: 600; margin-bottom: 8px; color: #0f172a; }
    p { font-size: 14px; color: #64748b; line-height: 1.5; margin-bottom: 0; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
  </div>
</body>
</html>
  `;
}
