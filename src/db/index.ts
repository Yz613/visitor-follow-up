import type {
  AuditLog,
  Draft,
  DraftStatus,
  Event,
  Person,
  Send,
  Site,
  Suppression,
} from '../types';

export class DatabaseRepository {
  private db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  // --- SITES ---
  async getSiteById(id: string): Promise<Site | null> {
    const res = await this.db.prepare('SELECT * FROM sites WHERE id = ?').bind(id).first<Site>();
    return res || null;
  }

  async getSiteByApiKey(apiKey: string): Promise<Site | null> {
    const res = await this.db.prepare('SELECT * FROM sites WHERE api_key = ?').bind(apiKey).first<Site>();
    return res || null;
  }

  async listSites(): Promise<Site[]> {
    const res = await this.db.prepare('SELECT * FROM sites ORDER BY name ASC').all<Site>();
    return res.results || [];
  }

  async createSite(site: Partial<Site> & { id: string; name: string; api_key: string; sender_name: string; sender_email: string; physical_address: string }): Promise<Site> {
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO sites (
          id, name, api_key, allowed_domains, sender_name, sender_email, reply_to,
          physical_address, go_live, confidence_threshold, frequency_cap_days,
          high_intent_pages, internal_domains, prompt_template, voice_description,
          email_provider, resend_api_key, posthog_api_key, posthog_project_id,
          posthog_host, webhook_url, webhook_secret, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        site.id,
        site.name,
        site.api_key,
        site.allowed_domains || '[]',
        site.sender_name,
        site.sender_email,
        site.reply_to || null,
        site.physical_address,
        site.go_live ?? 0,
        site.confidence_threshold ?? 0.8,
        site.frequency_cap_days ?? 7,
        site.high_intent_pages || '[]',
        site.internal_domains || '[]',
        site.prompt_template || null,
        site.voice_description || null,
        site.email_provider || 'resend',
        site.resend_api_key || null,
        site.posthog_api_key || null,
        site.posthog_project_id || null,
        site.posthog_host || 'https://us.i.posthog.com',
        site.webhook_url || null,
        site.webhook_secret || null,
        now,
        now
      )
      .run();

    const created = await this.getSiteById(site.id);
    if (!created) throw new Error('Failed to retrieve created site');
    return created;
  }

  async updateSite(id: string, updates: Partial<Site>): Promise<Site | null> {
    const existing = await this.getSiteById(id);
    if (!existing) return null;

    const merged = { ...existing, ...updates, updated_at: new Date().toISOString() };

    await this.db
      .prepare(
        `UPDATE sites SET
          name = ?, allowed_domains = ?, sender_name = ?, sender_email = ?, reply_to = ?,
          physical_address = ?, go_live = ?, confidence_threshold = ?, frequency_cap_days = ?,
          high_intent_pages = ?, internal_domains = ?, prompt_template = ?, voice_description = ?,
          email_provider = ?, resend_api_key = ?, posthog_api_key = ?, posthog_project_id = ?,
          posthog_host = ?, webhook_url = ?, webhook_secret = ?, updated_at = ?
        WHERE id = ?`
      )
      .bind(
        merged.name,
        merged.allowed_domains,
        merged.sender_name,
        merged.sender_email,
        merged.reply_to || null,
        merged.physical_address,
        merged.go_live,
        merged.confidence_threshold,
        merged.frequency_cap_days,
        merged.high_intent_pages,
        merged.internal_domains,
        merged.prompt_template || null,
        merged.voice_description || null,
        merged.email_provider,
        merged.resend_api_key || null,
        merged.posthog_api_key || null,
        merged.posthog_project_id || null,
        merged.posthog_host || 'https://us.i.posthog.com',
        merged.webhook_url || null,
        merged.webhook_secret || null,
        merged.updated_at,
        id
      )
      .run();

    return this.getSiteById(id);
  }

  // --- PERSONS ---
  async getPersonByEmail(siteId: string, email: string): Promise<Person | null> {
    const cleanEmail = email.trim().toLowerCase();
    const res = await this.db
      .prepare('SELECT * FROM persons WHERE site_id = ? AND email = ?')
      .bind(siteId, cleanEmail)
      .first<Person>();
    return res || null;
  }

  async getPersonById(personId: string): Promise<Person | null> {
    const res = await this.db.prepare('SELECT * FROM persons WHERE id = ?').bind(personId).first<Person>();
    return res || null;
  }

  async listPersons(siteId: string, limit = 100): Promise<Person[]> {
    const res = await this.db
      .prepare('SELECT * FROM persons WHERE site_id = ? ORDER BY last_seen_at DESC LIMIT ?')
      .bind(siteId, limit)
      .all<Person>();
    return res.results || [];
  }

  async upsertPerson(params: {
    siteId: string;
    email: string;
    traits?: Record<string, any>;
    emailSource: string;
    companyName?: string | null;
    companyDomain?: string | null;
    notes?: string | null;
    isCustomer?: boolean;
    customerSince?: string | null;
  }): Promise<Person> {
    const cleanEmail = params.email.trim().toLowerCase();
    const existing = await this.getPersonByEmail(params.siteId, cleanEmail);
    const now = new Date().toISOString();

    if (existing) {
      const mergedTraits = {
        ...(existing.traits ? JSON.parse(existing.traits) : {}),
        ...(params.traits || {}),
      };

      const isCust = params.isCustomer !== undefined ? (params.isCustomer ? 1 : 0) : existing.is_customer;
      const custSince = params.customerSince || existing.customer_since;
      const compName = params.companyName || existing.company_name;
      const compDom = params.companyDomain || existing.company_domain;
      const notes = params.notes ? (existing.notes ? `${existing.notes}\n${params.notes}` : params.notes) : existing.notes;

      await this.db
        .prepare(
          `UPDATE persons SET
            traits = ?, is_customer = ?, customer_since = ?, company_name = ?, company_domain = ?,
            notes = ?, last_seen_at = ?, updated_at = ?
          WHERE id = ?`
        )
        .bind(
          JSON.stringify(mergedTraits),
          isCust,
          custSince || null,
          compName || null,
          compDom || null,
          notes || null,
          now,
          now,
          existing.id
        )
        .run();

      const updated = await this.getPersonById(existing.id);
      return updated!;
    }

    const newId = `per_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    await this.db
      .prepare(
        `INSERT INTO persons (
          id, site_id, email, traits, email_source, is_customer, customer_since,
          company_name, company_domain, notes, last_seen_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        newId,
        params.siteId,
        cleanEmail,
        JSON.stringify(params.traits || {}),
        params.emailSource,
        params.isCustomer ? 1 : 0,
        params.customerSince || null,
        params.companyName || null,
        params.companyDomain || null,
        params.notes || null,
        now,
        now,
        now
      )
      .run();

    const created = await this.getPersonById(newId);
    return created!;
  }

  async markCustomer(siteId: string, email: string, isCustomer = true): Promise<void> {
    const cleanEmail = email.trim().toLowerCase();
    const now = new Date().toISOString();
    await this.db
      .prepare('UPDATE persons SET is_customer = ?, customer_since = ?, updated_at = ? WHERE site_id = ? AND email = ?')
      .bind(isCustomer ? 1 : 0, isCustomer ? now : null, now, siteId, cleanEmail)
      .run();
  }

  async markReplied(siteId: string, email: string, replied = true): Promise<void> {
    const cleanEmail = email.trim().toLowerCase();
    const now = new Date().toISOString();
    await this.db
      .prepare('UPDATE persons SET has_replied = ?, updated_at = ? WHERE site_id = ? AND email = ?')
      .bind(replied ? 1 : 0, now, siteId, cleanEmail)
      .run();
  }

  async updateLastEmailed(personId: string, emailedAt = new Date().toISOString()): Promise<void> {
    await this.db
      .prepare('UPDATE persons SET last_emailed_at = ?, updated_at = ? WHERE id = ?')
      .bind(emailedAt, emailedAt, personId)
      .run();
  }

  // --- EVENTS ---
  async recordEvent(params: {
    siteId: string;
    personId?: string | null;
    anonymousId?: string | null;
    eventName: string;
    url?: string | null;
    path?: string | null;
    referrer?: string | null;
    durationSeconds?: number;
    properties?: Record<string, any>;
    timestamp?: string;
  }): Promise<Event> {
    const id = `evt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const now = params.timestamp || new Date().toISOString();

    await this.db
      .prepare(
        `INSERT INTO events (
          id, site_id, person_id, anonymous_id, event_name, url, path, referrer,
          duration_seconds, properties, timestamp, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        params.siteId,
        params.personId || null,
        params.anonymousId || null,
        params.eventName,
        params.url || null,
        params.path || null,
        params.referrer || null,
        params.durationSeconds || 0,
        JSON.stringify(params.properties || {}),
        now,
        now
      )
      .run();

    return {
      id,
      site_id: params.siteId,
      person_id: params.personId || null,
      anonymous_id: params.anonymousId || null,
      event_name: params.eventName,
      url: params.url || null,
      path: params.path || null,
      referrer: params.referrer || null,
      duration_seconds: params.durationSeconds || 0,
      properties: JSON.stringify(params.properties || {}),
      timestamp: now,
      created_at: now,
    };
  }

  async linkAnonymousEvents(siteId: string, anonymousId: string, personId: string): Promise<number> {
    const res = await this.db
      .prepare('UPDATE events SET person_id = ? WHERE site_id = ? AND anonymous_id = ? AND person_id IS NULL')
      .bind(personId, siteId, anonymousId)
      .run();
    return res.meta?.changes || 0;
  }

  async getEventsForPerson(siteId: string, personId: string, limit = 50): Promise<Event[]> {
    const res = await this.db
      .prepare('SELECT * FROM events WHERE site_id = ? AND person_id = ? ORDER BY timestamp DESC LIMIT ?')
      .bind(siteId, personId, limit)
      .all<Event>();
    return res.results || [];
  }

  // --- SUPPRESSION LIST ---
  async isEmailSuppressed(siteId: string, email: string): Promise<boolean> {
    const cleanEmail = email.trim().toLowerCase();
    const res = await this.db
      .prepare('SELECT id FROM suppression_list WHERE site_id = ? AND email = ?')
      .bind(siteId, cleanEmail)
      .first<{ id: string }>();
    return !!res;
  }

  async addSuppression(siteId: string, email: string, reason = 'unsubscribe_link'): Promise<void> {
    const cleanEmail = email.trim().toLowerCase();
    const id = `sup_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const now = new Date().toISOString();

    await this.db
      .prepare(
        `INSERT OR REPLACE INTO suppression_list (id, site_id, email, reason, suppressed_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .bind(id, siteId, cleanEmail, reason, now)
      .run();
  }

  async listSuppression(siteId: string): Promise<Suppression[]> {
    const res = await this.db
      .prepare('SELECT * FROM suppression_list WHERE site_id = ? ORDER BY suppressed_at DESC')
      .bind(siteId)
      .all<Suppression>();
    return res.results || [];
  }

  // --- DRAFTS ---
  async createDraft(params: {
    siteId: string;
    personId: string;
    subject: string;
    bodyText: string;
    status?: DraftStatus;
    aiDecision?: 'send' | 'skip';
    aiReason: string;
    aiConfidence: number;
    aiPersona?: string | null;
    activitySummary?: string | null;
  }): Promise<Draft> {
    const id = `drf_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const now = new Date().toISOString();

    await this.db
      .prepare(
        `INSERT INTO drafts (
          id, site_id, person_id, subject, body_text, status, ai_decision,
          ai_reason, ai_confidence, ai_persona, activity_summary, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        params.siteId,
        params.personId,
        params.subject,
        params.bodyText,
        params.status || 'pending',
        params.aiDecision || 'send',
        params.aiReason,
        params.aiConfidence,
        params.aiPersona || null,
        params.activitySummary || null,
        now,
        now
      )
      .run();

    return {
      id,
      site_id: params.siteId,
      person_id: params.personId,
      subject: params.subject,
      body_text: params.bodyText,
      status: params.status || 'pending',
      ai_decision: params.aiDecision || 'send',
      ai_reason: params.aiReason,
      ai_confidence: params.aiConfidence,
      ai_persona: params.aiPersona || null,
      activity_summary: params.activitySummary || null,
      created_at: now,
      updated_at: now,
    };
  }

  async getDraftById(id: string): Promise<Draft | null> {
    const res = await this.db.prepare('SELECT * FROM drafts WHERE id = ?').bind(id).first<Draft>();
    return res || null;
  }

  async hasPendingDraft(siteId: string, personId: string): Promise<boolean> {
    const res = await this.db
      .prepare("SELECT id FROM drafts WHERE site_id = ? AND person_id = ? AND status = 'pending'")
      .bind(siteId, personId)
      .first<{ id: string }>();
    return !!res;
  }

  async listDrafts(params?: { siteId?: string; status?: DraftStatus; limit?: number }): Promise<Draft[]> {
    const limit = params?.limit || 50;
    let query = 'SELECT * FROM drafts';
    const conditions: string[] = [];
    const bindings: any[] = [];

    if (params?.siteId) {
      conditions.push('site_id = ?');
      bindings.push(params.siteId);
    }
    if (params?.status) {
      conditions.push('status = ?');
      bindings.push(params.status);
    }

    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }
    query += ' ORDER BY created_at DESC LIMIT ?';
    bindings.push(limit);

    const res = await this.db.prepare(query).bind(...bindings).all<Draft>();
    return res.results || [];
  }

  async updateDraft(id: string, updates: { status?: DraftStatus; subject?: string; bodyText?: string }): Promise<Draft | null> {
    const now = new Date().toISOString();
    const existing = await this.getDraftById(id);
    if (!existing) return null;

    const newStatus = updates.status || existing.status;
    const newSubject = updates.subject || existing.subject;
    const newBody = updates.bodyText || existing.body_text;

    await this.db
      .prepare('UPDATE drafts SET status = ?, subject = ?, body_text = ?, updated_at = ? WHERE id = ?')
      .bind(newStatus, newSubject, newBody, now, id)
      .run();

    return this.getDraftById(id);
  }

  // --- SENDS ---
  async recordSend(params: {
    siteId: string;
    personId: string;
    draftId?: string | null;
    toEmail: string;
    fromEmail: string;
    subject: string;
    bodyText: string;
    provider: string;
    providerMessageId?: string | null;
    status?: 'sent' | 'delivered' | 'failed' | 'bounced';
    errorMessage?: string | null;
  }): Promise<Send> {
    const id = `snd_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const now = new Date().toISOString();

    await this.db
      .prepare(
        `INSERT INTO sends (
          id, site_id, person_id, draft_id, to_email, from_email, subject,
          body_text, provider, provider_message_id, status, error_message, sent_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        params.siteId,
        params.personId,
        params.draftId || null,
        params.toEmail,
        params.fromEmail,
        params.subject,
        params.bodyText,
        params.provider,
        params.providerMessageId || null,
        params.status || 'sent',
        params.errorMessage || null,
        now
      )
      .run();

    return {
      id,
      site_id: params.siteId,
      person_id: params.personId,
      draft_id: params.draftId || null,
      to_email: params.toEmail,
      from_email: params.fromEmail,
      subject: params.subject,
      body_text: params.bodyText,
      provider: params.provider,
      provider_message_id: params.providerMessageId || null,
      status: params.status || 'sent',
      error_message: params.errorMessage || null,
      sent_at: now,
    };
  }

  async listSends(siteId?: string, limit = 50): Promise<Send[]> {
    let query = 'SELECT * FROM sends';
    const bindings: any[] = [];
    if (siteId) {
      query += ' WHERE site_id = ?';
      bindings.push(siteId);
    }
    query += ' ORDER BY sent_at DESC LIMIT ?';
    bindings.push(limit);

    const res = await this.db.prepare(query).bind(...bindings).all<Send>();
    return res.results || [];
  }

  // --- AUDIT LOGS ---
  async recordAuditLog(siteId: string, action: string, actor = 'system', details: Record<string, any> = {}): Promise<void> {
    const id = `aud_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const now = new Date().toISOString();

    await this.db
      .prepare('INSERT INTO audit_logs (id, site_id, action, actor, details, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, siteId, action, actor, JSON.stringify(details), now)
      .run();
  }

  async listAuditLogs(siteId?: string, limit = 50): Promise<AuditLog[]> {
    let query = 'SELECT * FROM audit_logs';
    const bindings: any[] = [];
    if (siteId) {
      query += ' WHERE site_id = ?';
      bindings.push(siteId);
    }
    query += ' ORDER BY created_at DESC LIMIT ?';
    bindings.push(limit);

    const res = await this.db.prepare(query).bind(...bindings).all<AuditLog>();
    return res.results || [];
  }

  // --- CANDIDATES FOR DECISION PIPELINE ---
  /**
   * Retrieves persons who have new activity (events with timestamp > last_emailed_at or never emailed)
   */
  async getPersonsWithNewActivity(siteId: string, limit = 50): Promise<Person[]> {
    const res = await this.db
      .prepare(
        `SELECT DISTINCT p.* FROM persons p
         JOIN events e ON e.person_id = p.id
         WHERE p.site_id = ?
           AND (p.last_emailed_at IS NULL OR e.timestamp > p.last_emailed_at)
         ORDER BY p.last_seen_at DESC
         LIMIT ?`
      )
      .bind(siteId, limit)
      .all<Person>();

    return res.results || [];
  }
}
