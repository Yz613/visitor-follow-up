// Core types for visitor-follow-up

export interface Site {
  id: string;
  name: string;
  api_key: string;
  allowed_domains: string; // JSON array of string domain names, e.g. ["refreshqueue.com", "localhost"]
  sender_name: string;
  sender_email: string;
  reply_to?: string | null;
  physical_address: string;
  go_live: number; // 0 = drafts only, 1 = auto-send high confidence
  confidence_threshold: number; // e.g. 0.80
  frequency_cap_days: number; // default 7
  high_intent_pages: string; // JSON array of path patterns e.g. ["/", "/#pricing", "/integrations"]
  internal_domains: string; // JSON array of internal domains to skip e.g. ["refreshqueue.com"]
  prompt_template?: string | null;
  voice_description?: string | null;
  email_provider: 'resend' | 'mock';
  resend_api_key?: string | null;
  posthog_api_key?: string | null;
  posthog_project_id?: string | null;
  posthog_host?: string | null;
  posthog_last_sync_at?: string | null;
  webhook_url?: string | null;
  webhook_secret?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ParsedSiteConfig {
  id: string;
  name: string;
  apiKey: string;
  allowedDomains: string[];
  senderName: string;
  senderEmail: string;
  replyTo?: string | null;
  physicalAddress: string;
  goLive: boolean;
  confidenceThreshold: number;
  frequencyCapDays: number;
  highIntentPages: string[];
  internalDomains: string[];
  promptTemplate?: string | null;
  voiceDescription?: string | null;
  emailProvider: 'resend' | 'mock';
  resendApiKey?: string | null;
  posthogApiKey?: string | null;
  posthogProjectId?: string | null;
  posthogHost?: string | null;
  posthogLastSyncAt?: string | null;
  webhookUrl?: string | null;
  webhookSecret?: string | null;
}

export interface Person {
  id: string;
  site_id: string;
  email: string;
  traits: string; // JSON object
  email_source: string; // e.g. 'form:integration-request', 'clerk:sign-in'
  is_customer: number; // 0 or 1
  customer_since?: string | null;
  has_replied: number; // 0 or 1
  company_id?: string | null;
  company_name?: string | null;
  company_domain?: string | null;
  notes?: string | null;
  last_seen_at: string;
  last_emailed_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Company {
  id: string;
  site_id: string;
  name: string;
  domain?: string | null;
  properties: string; // JSON object
  created_at: string;
}

export interface Event {
  id: string;
  site_id: string;
  person_id?: string | null;
  anonymous_id?: string | null;
  event_name: string;
  url?: string | null;
  path?: string | null;
  referrer?: string | null;
  duration_seconds: number;
  properties: string; // JSON object
  timestamp: string;
  created_at: string;
}

export interface Suppression {
  id: string;
  site_id: string;
  email: string;
  reason: 'unsubscribe_link' | 'list_unsubscribe' | 'manual_admin' | 'bounce' | 'spam_complaint' | string;
  suppressed_at: string;
}

export type DraftStatus = 'pending' | 'approved' | 'rejected' | 'sent' | 'skipped';

export interface Draft {
  id: string;
  site_id: string;
  person_id: string;
  subject: string;
  body_text: string;
  status: DraftStatus;
  ai_decision?: 'send' | 'skip' | null;
  ai_reason: string;
  ai_confidence: number;
  ai_persona?: string | null;
  activity_summary?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Send {
  id: string;
  site_id: string;
  person_id: string;
  draft_id?: string | null;
  to_email: string;
  from_email: string;
  subject: string;
  body_text: string;
  provider: string;
  provider_message_id?: string | null;
  status: 'sent' | 'delivered' | 'failed' | 'bounced';
  error_message?: string | null;
  sent_at: string;
}

export interface AuditLog {
  id: string;
  site_id: string;
  action: string;
  actor: string;
  details: string; // JSON object
  created_at: string;
}

export interface AIDecisionResult {
  decision: 'send' | 'skip';
  reason: string;
  persona: string;
  confidence: number; // 0.0 to 1.0
  subject?: string;
  body?: string;
}

export interface HardRuleEvaluation {
  canEmail: boolean;
  skipReason?: string;
}

export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  AI?: any; // Cloudflare Workers AI binding
  APP_URL?: string;
  ADMIN_PASSWORD?: string;
  SIGNING_SECRET?: string;
  RESEND_API_KEY?: string;
  ENVIRONMENT?: string;
  AI_MODEL?: string;
}
