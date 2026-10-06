# Self-Hosting Guide: visitor-follow-up

`visitor-follow-up` is designed to be completely self-hostable on your own Cloudflare account. It runs within Cloudflare Workers, Cloudflare D1 (serverless SQLite), Cloudflare KV, and Workers AI.

---

## Prerequisites

1. **Node.js**: v18+ installed on your machine.
2. **Cloudflare Account**: [Sign up for free](https://dash.cloudflare.com/sign-up).
3. **Resend Account**: [Sign up for Resend](https://resend.com) and generate an API key with a verified domain (or configure per-site Resend keys in the Admin UI).

---

## Step 1: Install Dependencies & Build

Clone or download this repository, then install dependencies:

```bash
cd visitor-follow-up
npm install
npm run build
```

---

## Step 2: Create Cloudflare D1 Database

Run the following command to provision your serverless SQLite D1 database:

```bash
npx wrangler d1 create visitor-follow-up-db
```

Output will display a database configuration block:
```toml
[[d1_databases]]
binding = "DB"
database_name = "visitor-follow-up-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

1. Open `wrangler.toml` and update the `database_id` under `[[d1_databases]]`.
2. Apply the database schema migrations:

```bash
# Apply migrations to your remote Cloudflare database
npx wrangler d1 migrations apply visitor-follow-up-db --remote

# (Optional) Apply migrations locally for local testing
npx wrangler d1 migrations apply visitor-follow-up-db --local
```

---

## Step 3: Create Cloudflare KV Namespace

Provision a KV namespace used for session storage and caching:

```bash
npx wrangler kv:namespace create KV
```

Output will display your KV namespace ID:
```toml
[[kv_namespaces]]
binding = "KV"
id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

Update `id` under `[[kv_namespaces]]` in `wrangler.toml`.

---

## Step 4: Configure Secrets & Environment Variables

### A. Set Cloudflare Secrets for Production

Run `wrangler secret put` for each required secret:

```bash
# 1. Admin UI access password
npx wrangler secret put ADMIN_PASSWORD

# 2. Secret key used for HMAC-SHA256 signing of unsubscribe tokens
npx wrangler secret put SIGNING_SECRET

# 3. Default Resend API key (sites can also override with their own key)
npx wrangler secret put RESEND_API_KEY
```

### B. Update Public Variables in `wrangler.toml`

Open `wrangler.toml` and update:
```toml
[vars]
ENVIRONMENT = "production"
APP_URL = "https://followup.yourdomain.com"
AI_MODEL = "@cf/cloudflare/clef"
```

---

## Step 5: Test Locally (Optional)

Create a local development `.dev.vars` file:

```bash
cp .env.example .dev.vars
```

Fill in `ADMIN_PASSWORD` and `SIGNING_SECRET` in `.dev.vars`, then start the local emulator:

```bash
npm run dev
```

Visit `http://localhost:8787/admin` in your browser and sign in using the password from `.dev.vars`.

---

## Step 6: Deploy to Cloudflare

Deploy your worker to production:

```bash
npm run deploy
```

Wrangler will package the worker, bundle the embedded tracking snippet, and upload it to your Cloudflare account.

---

## Step 7: Configure a Custom Domain (Recommended)

1. In the [Cloudflare Dashboard](https://dash.cloudflare.com/), go to **Workers & Pages** -> **visitor-follow-up**.
2. Click **Settings** -> **Triggers** -> **Custom Domains**.
3. Add a domain or subdomain (e.g., `followup.yourdomain.com`).
4. Ensure `APP_URL` in `wrangler.toml` matches your custom domain.

---

## Step 8: Register Your First Site

1. Open `https://followup.yourdomain.com/admin` in your browser.
2. Sign in with the `ADMIN_PASSWORD` you configured.
3. Click **Sites** -> **Register New Site**.
4. Fill in:
   - **Site ID**: e.g., `sales-coach`
   - **Site Name**: e.g., `Sales Coach`
   - **Sender Identity**: Name, email, physical mailing address
   - **High-Intent Pages**: e.g., `/, /#pricing, /integrations`
   - **Internal Domains**: e.g., `yourdomain.com`
   - **PostHog Personal API Key & Project ID** (optional)
   - **Resend API Key** (optional per-site override)
5. Copy the generated **Site API Key** to configure on your website or backend.

---

## Automated Background Crons

The worker is automatically scheduled to run every 15 minutes (`*/15 * * * *` in `wrangler.toml`). On each execution, it:
1. Syncs newly identified visitors and page events from configured PostHog accounts.
2. Runs the Decision Pipeline on returning visitors with new activity.
3. If **Go-Live** is OFF: generates drafts in `/admin` for manual review.
4. If **Go-Live** is ON: auto-sends high-confidence drafts and queues borderline cases for review.
