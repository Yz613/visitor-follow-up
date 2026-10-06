import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { adminRouter } from './api/routes/admin';
import { ingestRouter } from './api/routes/ingest';
import { unsubscribeRouter } from './api/routes/unsubscribe';
import { handleScheduled } from './cron/scheduler';
import { EMBEDDED_SNIPPET_JS } from './snippet/embedded';
import type { Env } from './types';

const app = new Hono<{ Bindings: Env }>();

// Global CORS for public ingest API and snippet
app.use(
  '/v1/*',
  cors({
    origin: '*',
    allowMethods: ['POST', 'GET', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Site-Key'],
  })
);

app.use(
  '/vf.js',
  cors({
    origin: '*',
    allowMethods: ['GET', 'HEAD', 'OPTIONS'],
  })
);

// Serve browser snippet
app.get('/vf.js', (c) => {
  return new Response(EMBEDDED_SNIPPET_JS, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
    },
  });
});

// Root / Health check
app.get('/', (c) => {
  return c.text('visitor-follow-up service is running. Visit /admin for dashboard.');
});

app.get('/health', (c) => {
  return c.json({ status: 'ok', service: 'visitor-follow-up' });
});

// Mount modular subrouters
app.route('/v1', ingestRouter);
app.route('/unsubscribe', unsubscribeRouter);
app.route('/admin', adminRouter);

export default {
  fetch: app.fetch,
  scheduled: handleScheduled,
};
