# Integration Guide: Refresh Queue / Sales Coach

This document details exactly how to integrate **visitor-follow-up** into [Sales Coach](https://refreshqueue.com) (Refresh Queue), a Next.js application deployed on Cloudflare with basePath `/app`.

> **Note**: This integration guide is standalone documentation. Nothing in the `visitor-follow-up` service depends on Sales Coach code, and no edits should be made directly to the Sales Coach repository from here.
> 
> **Brand & Compliance Rule**: Sales Coach marketing pages must **never** name third-party infrastructure or AI vendors. Vendor disclosures belong strictly on Sales Coach's `/privacy` page.

---

## 1. Overview & Architecture

Sales Coach runs on `refreshqueue.com` (with marketing routes served from `/app/marketing` and dynamic app routes at `/app/*`). It tracks client analytics through **PostHog Cloud (US, Project ID: `645997`)** via `src/lib/analytics-browser.ts`.

Because Sales Coach already invokes `posthog.identify(...)` on user sign-ins and form submissions, **the PostHog Connector is the primary automated ingest path**. Additionally, server-side API calls report customer conversions (Stripe checkout, workspace creation) to ensure paying customers are never emailed.

```
┌─────────────────────────────────────────────────────────────┐
│                       Sales Coach                           │
│  - Integration Request Form (/integrations)                 │
│  - Clerk Auth (/app/sign-up, /app/sign-in)                  │
│  - Stripe Checkout (src/lib/stripeCheckout.ts)              │
│  - High-Intent Pages (Calculator, Pricing, Integrations)    │
└──────────────┬──────────────────────────────┬───────────────┘
               │ PostHog Browser SDK          │ Server API (v1/conversions)
               ▼                              ▼
     ┌──────────────────┐           ┌──────────────────┐
     │  PostHog Cloud   │           │                  │
     │  Project: 645997 │           │                  │
     └─────────┬────────┘           │                  │
               │ Cron (every 15m)   │                  │
               ▼                    ▼                  │
┌─────────────────────────────────────────────────────────────┐
│                    visitor-follow-up                        │
│  - D1 Database: stores persons, events, suppressions        │
│  - Hard Rules: 7-day cap, customer skip, internal skip      │
│  - Workers AI (@cf/cloudflare/clef): plain-text drafts      │
│  - Go-Live switch (Review Queue vs Auto-Send)               │
│  - Sender: Yehuda <yehuda@refreshqueue.com> via Resend      │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. Site Configuration in visitor-follow-up

Register Sales Coach in the visitor-follow-up Admin UI (`/admin/sites`) or via database migration:

| Setting | Value | Rationale |
| :--- | :--- | :--- |
| **Site ID** | `sales-coach` | Unique identifier |
| **Site Name** | `Sales Coach` | Brand name for emails and headers |
| **Allowed Domains** | `refreshqueue.com, send.refreshqueue.com, localhost` | Valid origin domains for snippet and CORS |
| **Sender Name** | `Yehuda` | Friendly founder voice |
| **Sender Email** | `yehuda@refreshqueue.com` | Verified sending identity |
| **Reply-To** | `hello@refreshqueue.com` | Inbound replies go to shared inbox |
| **Physical Address** | `Refresh Queue Inc., 123 Tech Way, Suite 100, New York, NY 10001` | CAN-SPAM required physical mailing address |
| **Internal Domains** | `refreshqueue.com` | Skips all `@refreshqueue.com` employees |
| **Frequency Cap** | `7` days | Maximum 1 email per visitor per 7 days |
| **High-Intent Pages** | `/, /#pricing, /integrations, /app/sign-up, /app/marketing` | Pages signaling strong purchase intent |
| **Email Provider** | `resend` (sending domain: `send.refreshqueue.com`) | Dedicated transactional email sender |
| **PostHog Project** | `645997` (Host: `https://us.i.posthog.com`) | US Cloud PostHog instance |

---

## 3. Email Sources

Only visitors who explicitly share their email with Sales Coach are eligible for follow-up.

### Valid Email Sources

1. **Integration Request Form (`/integrations`)**:
   - Component: `src/components/IntegrationRequestForm.tsx`
   - Fields: `name`, `email`, `integration`, `useCase`
   - Handled by: `POST /app/api/marketing/integration-request` in `src/lib/integrationRequest.ts`
   - PostHog fires `posthog.identify(email, { name, integration, useCase })`
2. **Clerk Sign-up & Sign-in (`/app/sign-up`, `/app/sign-in`)**:
   - `src/lib/analytics-browser.ts` calls `posthog.identify(user.id, { email: user.primaryEmailAddress })`
3. **Stripe Checkout (`src/lib/stripeCheckout.ts`)**:
   - Passes `customer_email`. When checkout completes, server API marks person as paying customer (`is_customer: 1`), permanently excluding them from follow-up sales pitches.

### Explicitly Excluded Sources (NEVER Follow Up)

- The footer `mailto:hello@refreshqueue.com`
- Teammate invitations (internal colleagues invited by an existing workspace admin)
- Anonymous visits with no associated email

---

## 4. High-Intent Pages & Scoring

The follow-up decision pipeline monitors visits to high-intent sections of `refreshqueue.com`:

| Page / Component | Intent Signal |
| :--- | :--- |
| **Landing Page** (`/` or `/app/marketing`) | High interest in Sales Coach overview |
| **Pricing Section** (`/#pricing`) | High financial purchase intent |
| **Gong vs Sales Coach Cost Calculator** | Active comparison against incumbent solutions |
| **Integrations Directory** (`/integrations`) | Technical evaluation for CRM/stack compatibility |
| **Sign-up Flow** (`/app/sign-up`) | Dropped-off registration intent |

When a visitor returns to any of these URLs after previously submitting a form or signing up, Workers AI evaluates their intent.

---

## 5. Wiring Options for Sales Coach

### Option A: Automated PostHog Sync (Recommended — Zero Code Change)

Because Sales Coach already uses PostHog (`project 645997`) with `posthog.identify`:
1. Generate a **Personal API Key** in PostHog (`Settings` -> `User` -> `Personal API Keys`).
2. Enter the Personal API Key and Project ID `645997` in `visitor-follow-up` under the Sales Coach site settings.
3. The cron schedule runs every 15 minutes, discovers identified persons and their high-intent pageviews, and queues drafts.

### Option B: Adding the Browser Tracking Snippet

To capture high-intent sessions directly in real time without waiting for the 15-minute PostHog polling cycle:

Add to Sales Coach's root layout (`src/app/layout.tsx`):
```html
<script
  src="https://followup.refreshqueue.com/vf.js"
  data-site="sales-coach"
  async
></script>
```

Or auto-hook the integration request form by adding `data-vf-auto-hook`:
```tsx
<form onSubmit={handleSubmit} data-vf-auto-hook data-vf-source="integration-request">
  <input type="text" name="name" placeholder="Your Name" />
  <input type="email" name="email" placeholder="Work Email" required />
  <input type="text" name="integration" placeholder="Desired Integration" />
  <button type="submit">Request Integration</button>
</form>
```

### Option C: Server API Calls for Customer Status

To guarantee customers who paid or created a workspace are **never** emailed, trigger a POST from Sales Coach's Stripe webhook handler or workspace creation API:

```typescript
// Example inside Sales Coach backend (e.g. Stripe webhook handler):
await fetch('https://followup.refreshqueue.com/v1/conversions', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.VISITOR_FOLLOW_UP_API_KEY}`,
  },
  body: JSON.stringify({
    site_id: 'sales-coach',
    email: session.customer_details?.email,
    conversion_type: 'stripe_subscription_paid',
    amount: session.amount_total,
    is_customer: true, // Hard rule: permanently skips future marketing emails
  }),
});
```

---

## 6. Email Voice, Tone & Sample Drafts

### Voice Guidelines for Sales Coach
- **Identity**: Yehuda (Founder of Sales Coach)
- **Tone**: Plain-text founder email, direct, helpful, zero sales jargon or artificial urgency.
- **Length**: Under 120 words.
- **Call to Action**: Exactly one low-friction ask (e.g., offer API docs, custom CRM build, or 10-minute walkthrough).

### Example Output

```
Subject: Quick question about Sales Coach integrations

Hi Alex,

Saw you were checking out the Gong calculator and our integrations page earlier today.

Are you looking to connect with HubSpot or a custom CRM? Happy to share our technical specs or hop on a quick call if that would help.

Best,
Yehuda

--
Yehuda
Refresh Queue Inc., 123 Tech Way, Suite 100, New York, NY 10001

Unsubscribe: https://followup.refreshqueue.com/unsubscribe?site=sales-coach&email=alex%40example.com&token=...
```

---

## 7. Go-Live Strategy

1. **Phase 1: Review Mode (`go_live = 0`)**
   - All AI decisions generate pending drafts in the Admin UI (`/admin`).
   - Review drafts, activity summaries, and confidence scores for 1-2 weeks.
   - Click "Approve & Send" or "Edit then Send" manually.
2. **Phase 2: Automated High-Confidence (`go_live = 1`, `confidence_threshold = 0.85`)**
   - Toggle Go-Live ON in the Admin UI.
   - Drafts with confidence $\ge 85\%$ send automatically.
   - Borderline drafts wait in the review queue.
