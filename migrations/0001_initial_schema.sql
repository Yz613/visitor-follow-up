-- Initial database schema for visitor-follow-up

-- 1. Connected Sites ("sources")
CREATE TABLE IF NOT EXISTS sites (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    api_key TEXT NOT NULL UNIQUE,
    allowed_domains TEXT NOT NULL DEFAULT '[]', -- JSON array of strings
    sender_name TEXT NOT NULL,
    sender_email TEXT NOT NULL,
    reply_to TEXT,
    physical_address TEXT NOT NULL, -- CAN-SPAM physical mailing address
    go_live INTEGER NOT NULL DEFAULT 0, -- 0 = drafts only, 1 = auto-send high confidence
    confidence_threshold REAL NOT NULL DEFAULT 0.80,
    frequency_cap_days INTEGER NOT NULL DEFAULT 7,
    high_intent_pages TEXT NOT NULL DEFAULT '[]', -- JSON array of path patterns
    internal_domains TEXT NOT NULL DEFAULT '[]', -- JSON array of domains to skip
    prompt_template TEXT,
    voice_description TEXT DEFAULT 'Friendly, concise, plain-text founder voice. Under 120 words. No hype or buzzwords. One clear ask.',
    email_provider TEXT NOT NULL DEFAULT 'resend',
    resend_api_key TEXT,
    posthog_api_key TEXT,
    posthog_project_id TEXT,
    posthog_host TEXT NOT NULL DEFAULT 'https://us.i.posthog.com',
    posthog_last_sync_at TEXT,
    webhook_url TEXT,
    webhook_secret TEXT,
    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

-- 2. Companies (optional enrichment)
CREATE TABLE IF NOT EXISTS companies (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    domain TEXT,
    properties TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    UNIQUE(site_id, name)
);

-- 3. Identified Persons
CREATE TABLE IF NOT EXISTS persons (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    traits TEXT NOT NULL DEFAULT '{}', -- JSON object
    email_source TEXT NOT NULL, -- e.g. form:integration-request, clerk:sign-in, server_api
    is_customer INTEGER NOT NULL DEFAULT 0, -- 1 = paying customer, hard rule skip
    customer_since TEXT,
    has_replied INTEGER NOT NULL DEFAULT 0, -- 1 = replied, hard rule skip
    company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
    company_name TEXT,
    company_domain TEXT,
    notes TEXT,
    last_seen_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    last_emailed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    UNIQUE(site_id, email)
);

-- 4. Visits and Events
CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    person_id TEXT REFERENCES persons(id) ON DELETE CASCADE,
    anonymous_id TEXT,
    event_name TEXT NOT NULL, -- e.g. '$pageview', 'page_view', 'checkout_started'
    url TEXT,
    path TEXT,
    referrer TEXT,
    duration_seconds REAL DEFAULT 0,
    properties TEXT NOT NULL DEFAULT '{}',
    timestamp TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

-- 5. Suppression List (never email suppressed addresses)
CREATE TABLE IF NOT EXISTS suppression_list (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT 'unsubscribe', -- unsubscribe_link, list_unsubscribe, manual_admin, bounce
    suppressed_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    UNIQUE(site_id, email)
);

-- 6. Generated Email Drafts
CREATE TABLE IF NOT EXISTS drafts (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    person_id TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    subject TEXT NOT NULL,
    body_text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- pending, approved, rejected, sent, skipped
    ai_decision TEXT, -- send, skip
    ai_reason TEXT NOT NULL,
    ai_confidence REAL NOT NULL DEFAULT 0.0,
    ai_persona TEXT,
    activity_summary TEXT,
    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

-- 7. Sent Emails
CREATE TABLE IF NOT EXISTS sends (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    person_id TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    draft_id TEXT REFERENCES drafts(id) ON DELETE SET NULL,
    to_email TEXT NOT NULL,
    from_email TEXT NOT NULL,
    subject TEXT NOT NULL,
    body_text TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'resend',
    provider_message_id TEXT,
    status TEXT NOT NULL DEFAULT 'sent', -- sent, delivered, failed, bounced
    error_message TEXT,
    sent_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

-- 8. Audit Log
CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    action TEXT NOT NULL, -- rule.skipped, draft.created, email.sent, draft.approved, person.unsubscribed, sync.posthog
    actor TEXT NOT NULL DEFAULT 'system',
    details TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_persons_site_email ON persons(site_id, email);
CREATE INDEX IF NOT EXISTS idx_persons_site_last_seen ON persons(site_id, last_seen_at);
CREATE INDEX IF NOT EXISTS idx_events_site_person ON events(site_id, person_id);
CREATE INDEX IF NOT EXISTS idx_events_site_anon ON events(site_id, anonymous_id);
CREATE INDEX IF NOT EXISTS idx_events_site_timestamp ON events(site_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_suppression_site_email ON suppression_list(site_id, email);
CREATE INDEX IF NOT EXISTS idx_drafts_site_status ON drafts(site_id, status);
CREATE INDEX IF NOT EXISTS idx_sends_site_person ON sends(site_id, person_id);
CREATE INDEX IF NOT EXISTS idx_audit_site_created ON audit_logs(site_id, created_at);
