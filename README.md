# visitor-follow-up

A standalone, open-source (MIT), self-hostable service that any website or SaaS application can plug into to automatically follow up by email with known visitors who come back.

Built entirely on the Cloudflare edge stack: **Cloudflare Workers (TypeScript) + D1 + KV + Workers AI**, deployed with `wrangler`.

---

## Why visitor-follow-up?

Most SaaS sites capture email addresses across forms, sign-up flows, or demo requests, but lose potential customers when those visitors return days later to review pricing or integrations without converting. 

`visitor-follow-up` solves this without creepy tracking or spam:
- **Permission-Only**: Only emails people who directly gave the site their address. Never emails anonymous visitors, scrapes emails, or buys third-party data.
- **Hard Rules in Code**: Frequency cap (default 7 days), suppression checks, internal domain skips, customer skips, and reply skips are strictly enforced in code — **never left to an LLM**.
- **Plain-Text Founder Voice**: Uses Cloudflare Workers AI (`@cf/cloudflare/clef`) to draft natural, plain-text emails strictly under 120 words with zero marketing hype and exactly one clear, low-friction ask.
- **Go-Live Safety Switch**: Starts in review mode (drafts only). When ready, toggle Go-Live ON to auto-send high-confidence follow-ups while queuing borderline drafts for human review.
- **CAN-SPAM Compliant**: Automatic physical address footer, `List-Unsubscribe` headers, and signed one-click unsubscribe links.

---

## 5-Minute Install for Any Site

`visitor-follow-up` supports multi-site configurations from day one. You can ingest visitor activity through any of three flexible methods:

### Method 1: Tiny Browser Snippet

Embed the lightweight snippet (< 4KB) in your HTML:

```html
<script
  src="https://followup.yourdomain.com/vf.js"
  data-site="your-site-id"
  async
></script>
```

#### Auto Form Hooking
Add `data-vf-auto-hook` to any HTML form. When a visitor submits their email, the snippet automatically identifies them:

```html
<form action="/api/contact" method="POST" data-vf-auto-hook data-vf-source="contact-form">
  <input type="text" name="name" placeholder="Name" />
  <input type="email" name="email" placeholder="Work Email" required />
  <button type="submit">Submit</button>
</form>
```

#### Manual JavaScript Tracking
```javascript
// Identify a visitor when they log in or provide their address
window.vf.identify('alex@example.com', { name: 'Alex', company: 'Acme Corp' });

// Track specific feature interactions or button clicks
window.vf.track('calculator_compared', { competitor: 'Gong', savings: 12000 });
```

---

### Method 2: NPM Package

Install in your React, Next.js, or Vue frontend:

```bash
npm install visitor-follow-up
```

```typescript
import vf from 'visitor-follow-up';

// Initialize in your app root
vf.init({
  siteId: 'your-site-id',
  endpoint: 'https://followup.yourdomain.com',
  autoPageview: true,
  autoHookForms: true,
});

// Identify on authentication
vf.identify(user.email, { name: user.name });
```

---

### Method 3: Server API

Call the ingest endpoints directly from your backend with your site API key:

#### Identify Visitor
```bash
curl -X POST https://followup.yourdomain.com/v1/identify \
  -H "Authorization: Bearer vfu_live_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "alex@example.com",
    "traits": { "name": "Alex", "plan_interest": "pro" },
    "email_source": "form:demo_request",
    "company": "Acme Corp"
  }'
```

#### Record Event / Pageview
```bash
curl -X POST https://followup.yourdomain.com/v1/events \
  -H "Authorization: Bearer vfu_live_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "alex@example.com",
    "event": "page_view",
    "path": "/#pricing",
    "duration_seconds": 60
  }'
```

#### Record Conversion (Marks Customer & Permanently Skips Follow-Ups)
```bash
curl -X POST https://followup.yourdomain.com/v1/conversions \
  -H "Authorization: Bearer vfu_live_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "alex@example.com",
    "conversion_type": "stripe_checkout_paid",
    "is_customer": true
  }'
```

---

### Method 4: Automated PostHog Connector (Zero Frontend Code)

If your website already uses [PostHog](https://posthog.com):
1. In `visitor-follow-up`'s Admin UI, enter your PostHog **Personal API Key** and **Project ID**.
2. The built-in Cloudflare Worker cron runs every 15 minutes, automatically importing identified persons and high-intent pageviews.

---

## Pipeline Overview

```
1. Ingest (Snippet / API / PostHog) ──► D1 Database
                                             │
2. Returning Activity Detected ──────────────┘
   │
   ▼
3. Hard Rules Engine (Code Level)
   ├── Anonymous? ──────────────► SKIP
   ├── Suppressed? ─────────────► SKIP
   ├── Internal Domain? ────────► SKIP
   ├── Customer / Paid? ────────► SKIP
   ├── Already Replied? ────────► SKIP
   └── Frequency Cap (< 7d)? ───► SKIP
   │
   ▼ (Passes all rules)
4. Workers AI Decision & Drafting (@cf/cloudflare/clef)
   ├── Evaluates pages, duration, high-intent visits
   └── Drafts plain-text email under 120 words (1 ask)
   │
   ▼
5. Go-Live Switch Check
   ├── Go-Live OFF ─────────────► Save Pending Draft for Admin Review
   └── Go-Live ON
       ├── Confidence >= 80% ───► Auto-Send (Resend) + Update Last Emailed
       └── Confidence < 80% ────► Save Pending Draft for Admin Review
```

---

## Email Senders & Outbound Webhooks

- **Email Senders**: Resend adapter implemented first (per-site API key or global fallback). Interface ready for SMTP, Postmark, and SES.
- **Outbound Webhooks**: Notify your host site when key lifecycle events occur (`draft.created`, `email.sent`, `person.unsubscribed`). Payload is signed with HMAC-SHA256 (`X-Visitor-Signature: sha256=...`).

---

## Admin Dashboard

The Worker serves a built-in admin UI at `/admin`:
- **Drafts Review Queue**: View pending drafts with recipient activity history, AI reasoning, persona label, and confidence score badge. Actions: "Approve & Send", "Edit then Send", "Skip".
- **Sites Management**: Register and configure multiple sites, toggle the Go-Live switch, configure high-intent pages, and view API keys.
- **Visitors Directory**: View identified visitors, customer status, and suppression records.
- **Audit Logs**: Complete timeline of sends, skips, syncs, and unsubscribes.

---

## Verification & Tests

Run the comprehensive test suite verifying all hard constraints, tokens, adapters, and pipelines:

```bash
# Run unit & integration tests
npm test

# Typecheck with TypeScript
npm run typecheck

# Build browser snippet and worker bundle
npm run build
```

---

## Documentation

- [Self-Hosting Guide (SELF-HOST.md)](./SELF-HOST.md): Complete setup commands for your own Cloudflare account.
- [Privacy Policy Template (PRIVACY.md)](./PRIVACY.md): A ready-to-use privacy disclosure for host websites.
- [Sales Coach Integration Guide (docs/integrations/sales-coach.md)](./docs/integrations/sales-coach.md): Specific integration details for [refreshqueue.com](https://refreshqueue.com).
- [License (MIT)](./LICENSE)
