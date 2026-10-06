import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import { generateUnsubscribeToken } from '../src/core/tokens';

function createMockD1() {
  const tables: Record<string, any[]> = {
    sites: [
      {
        id: 'sales-coach',
        name: 'Sales Coach',
        api_key: 'vfu_live_sales_coach_key',
        allowed_domains: JSON.stringify(['refreshqueue.com', 'localhost']),
        sender_name: 'Yehuda',
        sender_email: 'yehuda@refreshqueue.com',
        reply_to: null,
        physical_address: '123 Tech Way',
        go_live: 0,
        confidence_threshold: 0.8,
        frequency_cap_days: 7,
        high_intent_pages: '[]',
        internal_domains: '[]',
        prompt_template: null,
        voice_description: null,
        email_provider: 'resend',
      },
    ],
    persons: [],
    events: [],
    suppression_list: [],
    drafts: [],
    sends: [],
    audit_logs: [],
  };

  return {
    prepare(query: string) {
      return {
        bind(...args: any[]) {
          return {
            async first<T = any>() {
              if (query.includes('FROM sites WHERE api_key = ?')) {
                const site = tables.sites.find((s) => s.api_key === args[0]);
                return (site || null) as T;
              }
              if (query.includes('FROM sites WHERE id = ?')) {
                const site = tables.sites.find((s) => s.id === args[0]);
                return (site || null) as T;
              }
              if (query.includes('FROM persons WHERE id = ?')) {
                const p = tables.persons.find((p) => p.id === args[0]);
                return (p || null) as T;
              }
              if (query.includes('FROM persons WHERE site_id = ? AND email = ?')) {
                const p = tables.persons.find((p) => p.site_id === args[0] && p.email === args[1]);
                return (p || null) as T;
              }
              if (query.includes('FROM suppression_list WHERE site_id = ? AND email = ?')) {
                const s = tables.suppression_list.find((s) => s.site_id === args[0] && s.email === args[1]);
                return (s ? { id: s.id } : null) as T;
              }
              return null as T;
            },
            async all<T = any>() {
              if (query.includes('FROM sites')) {
                return { results: tables.sites as T[] };
              }
              if (query.includes('FROM persons')) {
                return { results: tables.persons as T[] };
              }
              return { results: [] };
            },
            async run() {
              if (query.includes('INSERT INTO persons')) {
                tables.persons.push({
                  id: args[0],
                  site_id: args[1],
                  email: args[2],
                  traits: args[3],
                  email_source: args[4],
                  is_customer: args[5],
                });
              }
              if (query.includes('INSERT INTO events')) {
                tables.events.push({
                  id: args[0],
                  site_id: args[1],
                  event_name: args[4],
                });
              }
              if (query.includes('INSERT OR REPLACE INTO suppression_list')) {
                tables.suppression_list.push({
                  id: args[0],
                  site_id: args[1],
                  email: args[2],
                  reason: args[3],
                });
              }
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
}

describe('Worker HTTP Endpoints', () => {
  const mockEnv: any = {
    DB: createMockD1(),
    KV: {},
    SIGNING_SECRET: 'test-signing-secret',
    APP_URL: 'http://localhost:8787',
  };

  it('GET /health returns 200 OK', async () => {
    const res = await worker.fetch(new Request('http://localhost/health'), mockEnv, {} as any);
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.status).toBe('ok');
  });

  it('GET /vf.js serves the browser snippet with caching headers', async () => {
    const res = await worker.fetch(new Request('http://localhost/vf.js'), mockEnv, {} as any);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('javascript');
    expect(res.headers.get('Cache-Control')).toContain('max-age');
    const text = await res.text();
    expect(text.length).toBeGreaterThan(100);
  });

  it('POST /v1/identify registers identified visitor with valid site API key', async () => {
    const req = new Request('http://localhost/v1/identify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer vfu_live_sales_coach_key',
      },
      body: JSON.stringify({
        email: 'founder@prospect.com',
        traits: { name: 'Sarah', role: 'CTO' },
        email_source: 'form:integration-request',
        company: 'Prospect Inc',
      }),
    });

    const res = await worker.fetch(req, mockEnv, {} as any);
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.success).toBe(true);
    expect(data.email).toBe('founder@prospect.com');
  });

  it('POST /v1/identify rejects missing or invalid email', async () => {
    const req = new Request('http://localhost/v1/identify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer vfu_live_sales_coach_key',
      },
      body: JSON.stringify({
        email: 'invalid-email',
      }),
    });

    const res = await worker.fetch(req, mockEnv, {} as any);
    expect(res.status).toBe(400);
  });

  it('POST /v1/identify rejects unauthorized requests', async () => {
    const req = new Request('http://localhost/v1/identify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer invalid_key',
      },
      body: JSON.stringify({
        email: 'test@example.com',
      }),
    });

    const res = await worker.fetch(req, mockEnv, {} as any);
    expect(res.status).toBe(401);
  });

  it('POST /v1/events records page view and custom events', async () => {
    const req = new Request('http://localhost/v1/events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer vfu_live_sales_coach_key',
      },
      body: JSON.stringify({
        email: 'founder@prospect.com',
        event: 'page_view',
        path: '/#pricing',
        duration_seconds: 35,
      }),
    });

    const res = await worker.fetch(req, mockEnv, {} as any);
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.success).toBe(true);
    expect(data.event_id).toBeTruthy();
  });

  it('GET /unsubscribe validates token and renders confirmation page', async () => {
    const token = await generateUnsubscribeToken('sales-coach', 'founder@prospect.com', 'test-signing-secret');
    const req = new Request(`http://localhost/unsubscribe?site=sales-coach&email=founder@prospect.com&token=${token}`);

    const res = await worker.fetch(req, mockEnv, {} as any);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Unsubscribe Confirmation');
    expect(html).toContain('Sales Coach');
  });

  it('POST /unsubscribe adds email to suppression and returns confirmation', async () => {
    const token = await generateUnsubscribeToken('sales-coach', 'founder@prospect.com', 'test-signing-secret');
    const req = new Request(`http://localhost/unsubscribe?site=sales-coach&email=founder@prospect.com&token=${token}`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
    });

    const res = await worker.fetch(req, mockEnv, {} as any);
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.unsubscribed).toBe(true);
  });
});
