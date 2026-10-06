Build "visitor-follow-up": a standalone, open-source (MIT) service that any website or SaaS app can plug into to automatically follow up by email with known visitors who come back. It lives in this folder as its own project and repo. Refresh Queue / Sales Coach (refreshqueue.com) is the first site that will use it, but nothing in this project may depend on Sales Coach code.

STACK
Cloudflare Worker (TypeScript) + D1 + KV + Workers AI, deployed with wrangler. Admin UI served by the same Worker (simple server-rendered pages or a small React/Vite SPA). Also provide a tiny browser snippet/npm package for sites to install. Keep it self-hostable: anyone can deploy their own copy with their own Cloudflare account.

HOW SITES PLUG IN (the core design: adapters, not hardcoding)
1. Site registration: each connected site ("source") has an id, name, allowed domains, sender identity (from name/address, reply-to), physical mailing address, and its own API key. Multi-site from day one.
2. Ingest options (support all three):
   a. Browser snippet: <script src=".../vf.js" data-site="..."> or `npm i visitor-follow-up`; exposes vf.identify(email, traits) and vf.track(event, props), auto-captures page views, and can auto-hook forms with an email field (opt-in per form via data attribute).
   b. Server API: POST /v1/identify, /v1/events, /v1/conversions with the site API key, so a backend can report sign-ups, form submissions, checkout started/paid, etc.
   c. Analytics connectors: pull identified persons and their events from PostHog (personal API key + project id per site) on a cron every 15 minutes. Design a connector interface so others (GA4, Segment, Plausible) can be added later.
3. Email senders as adapters: Resend first (API key per site); interface ready for SMTP/Postmark/SES.
4. Webhooks out: notify the host site when a draft is created, an email is sent, or someone unsubscribes.

PIPELINE
1. People and visits stored in D1: person (site, email, traits, email source), events, company (optional), suppression list, drafts, sends, audit log.
2. Decide: for each identified person with new activity, call Workers AI (binding AI, model @cf/cloudflare/clef) with their history (pages, time on page, high-intent pages configured per site, visit count, email source, notes the site sent, past emails) and get structured JSON: send or skip, reason, persona, confidence.
   Hard rules in code, never left to the model: max 1 email per person per 7 days (configurable per site), never email suppressed addresses, skip internal domains per site, skip people the site marks as customers/paid or who replied.
3. Draft: plain-text email under 120 words in the site's configured voice and sender, no hype, references what they looked at without being creepy, one clear ask. Per-site prompt template, editable in the admin.
4. Approve: admin UI listing pending drafts per site with activity summary, reason and confidence. Approve and send, edit then send, skip. Full log of everything sent and skipped.
5. Go-live switch per site, default OFF. OFF = drafts only. ON = high-confidence drafts auto-send; the rest wait for approval.
6. Send with List-Unsubscribe header, a one-click /unsubscribe page (signed token, per site) writing to suppression, and the site's physical address footer (CAN-SPAM).
7. Admin login: simple email magic link or a single admin password from a secret; per-site access.

PRIVACY AND SCOPE
- Only email people who gave the site their address (identify calls / server API). Never email anonymous visitors. No third-party identity resolution or cold-email tools.
- Optional company enrichment: accept company name/domain from the host site (e.g. from a separate visitor-company lookup). Never use it to identify individuals.
- Ship a short PRIVACY.md template that host sites can adapt for their privacy page.

FIRST INTEGRATION: REFRESH QUEUE / SALES COACH (document it in docs/integrations/sales-coach.md; do NOT edit the Sales Coach repo from here)
Sales Coach is a Next.js app on Cloudflare at refreshqueue.com (repo folder ../Sales Coach, basePath /app). Write exactly how to wire it in:
- Email sources: the integration request form on /integrations (src/components/IntegrationRequestForm.tsx: name, email, integration, useCase; POST /app/api/marketing/integration-request handled in src/lib/integrationRequest.ts), Clerk sign-up/sign-in (/app/sign-up, /app/sign-in; no Clerk webhook exists yet), and Stripe checkout (src/lib/stripeCheckout.ts passes customer_email). Not sources: the footer mailto hello@refreshqueue.com and teammate invites.
- It already runs PostHog (US cloud, project 645997) via src/lib/analytics-browser.ts, which calls posthog.identify on sign-in and on form submit, so the PostHog connector is the easiest path; the server API should report checkout started/paid and workspace created.
- High-intent pages: / (landing at /app/marketing), /#pricing, the Gong vs Sales Coach cost calculator on the landing page, /integrations, /app/sign-up.
- Sender: Yehuda <yehuda@refreshqueue.com> via Resend on send.refreshqueue.com. Internal domain to skip: refreshqueue.com.
- Note that Sales Coach marketing pages must not name infrastructure/vendors; vendor names only on its /privacy page.

DELIVERABLES
- Working Worker with migrations, cron, ingest API, PostHog connector, Resend sender, admin UI, unsubscribe flow, browser snippet.
- README (what it is, 5-minute install for any site), SELF-HOST.md (deploy to your own Cloudflare), .env.example / wrangler secrets list, docs/integrations/sales-coach.md.
- Tests for hard rules (frequency cap, suppression, internal skip, customer skip), go-live switch, unsubscribe tokens, API key auth, and adapter interfaces. `npm test`, typecheck and build must pass.
- Do not deploy or create cloud resources; leave the wrangler config with placeholder ids and document the setup commands.
