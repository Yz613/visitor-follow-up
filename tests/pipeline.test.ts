import { beforeEach, describe, expect, it } from 'vitest';
import { MockAIProvider } from '../src/adapters/ai/mock';
import { MockEmailSender } from '../src/adapters/email/mock';
import { DecisionPipeline } from '../src/core/pipeline';
import type { Draft, Event, Person, Send, Site } from '../src/types';

// In-memory test repository simulating D1 database for pipeline testing
class InMemoryTestRepository {
  public sites = new Map<string, Site>();
  public persons = new Map<string, Person>();
  public events: Event[] = [];
  public suppression = new Set<string>(); // "siteId:email"
  public drafts = new Map<string, Draft>();
  public sends: Send[] = [];
  public auditLogs: any[] = [];

  async getSiteById(id: string): Promise<Site | null> {
    return this.sites.get(id) || null;
  }

  async getPersonByEmail(siteId: string, email: string): Promise<Person | null> {
    for (const p of this.persons.values()) {
      if (p.site_id === siteId && p.email.toLowerCase() === email.toLowerCase()) {
        return p;
      }
    }
    return null;
  }

  async getPersonById(id: string): Promise<Person | null> {
    return this.persons.get(id) || null;
  }

  async isEmailSuppressed(siteId: string, email: string): Promise<boolean> {
    return this.suppression.has(`${siteId}:${email.toLowerCase()}`);
  }

  async hasPendingDraft(siteId: string, personId: string): Promise<boolean> {
    for (const d of this.drafts.values()) {
      if (d.site_id === siteId && d.person_id === personId && d.status === 'pending') {
        return true;
      }
    }
    return false;
  }

  async getEventsForPerson(siteId: string, personId: string): Promise<Event[]> {
    return this.events.filter((e) => e.site_id === siteId && e.person_id === personId);
  }

  async createDraft(params: any): Promise<Draft> {
    const id = `drf_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const draft: Draft = {
      id,
      site_id: params.siteId,
      person_id: params.personId,
      subject: params.subject,
      body_text: params.bodyText,
      status: params.status || 'pending',
      ai_decision: params.aiDecision,
      ai_reason: params.aiReason,
      ai_confidence: params.aiConfidence,
      ai_persona: params.aiPersona,
      activity_summary: params.activitySummary,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.drafts.set(id, draft);
    return draft;
  }

  async getDraftById(id: string): Promise<Draft | null> {
    return this.drafts.get(id) || null;
  }

  async updateDraft(id: string, updates: any): Promise<Draft | null> {
    const d = this.drafts.get(id);
    if (!d) return null;
    const updated = { ...d, ...updates };
    this.drafts.set(id, updated);
    return updated;
  }

  async recordSend(params: any): Promise<Send> {
    const send: Send = {
      id: `snd_${Date.now()}`,
      site_id: params.siteId,
      person_id: params.personId,
      draft_id: params.draftId,
      to_email: params.toEmail,
      from_email: params.fromEmail,
      subject: params.subject,
      body_text: params.bodyText,
      provider: params.provider,
      provider_message_id: params.providerMessageId,
      status: params.status || 'sent',
      sent_at: new Date().toISOString(),
    };
    this.sends.push(send);
    return send;
  }

  async updateLastEmailed(personId: string): Promise<void> {
    const p = this.persons.get(personId);
    if (p) {
      p.last_emailed_at = new Date().toISOString();
    }
  }

  async recordAuditLog(siteId: string, action: string, actor: string, details: any): Promise<void> {
    this.auditLogs.push({ siteId, action, actor, details, created_at: new Date().toISOString() });
  }

  async listSends(): Promise<Send[]> {
    return this.sends;
  }

  async getPersonsWithNewActivity(siteId: string): Promise<Person[]> {
    return Array.from(this.persons.values()).filter((p) => p.site_id === siteId);
  }
}

describe('Decision Pipeline & Go-Live Switch', () => {
  let repo: InMemoryTestRepository;
  let mockAI: MockAIProvider;
  let mockSender: MockEmailSender;
  let pipeline: DecisionPipeline;

  const defaultSite: Site = {
    id: 'sales-coach',
    name: 'Sales Coach',
    api_key: 'vfu_live_salescoach_123',
    allowed_domains: JSON.stringify(['refreshqueue.com']),
    sender_name: 'Yehuda',
    sender_email: 'yehuda@refreshqueue.com',
    reply_to: null,
    physical_address: 'Sales Coach, 123 Tech Way, Suite 100, New York, NY 10001',
    go_live: 0, // Default OFF
    confidence_threshold: 0.8,
    frequency_cap_days: 7,
    high_intent_pages: JSON.stringify(['/#pricing', '/integrations']),
    internal_domains: JSON.stringify(['refreshqueue.com']),
    prompt_template: null,
    voice_description: null,
    email_provider: 'mock',
    resend_api_key: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const defaultPerson: Person = {
    id: 'per_1',
    site_id: 'sales-coach',
    email: 'prospect@acmecorp.com',
    traits: JSON.stringify({ name: 'Alex' }),
    email_source: 'form:integration-request',
    is_customer: 0,
    has_replied: 0,
    last_seen_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  beforeEach(() => {
    repo = new InMemoryTestRepository();
    repo.sites.set(defaultSite.id, { ...defaultSite });
    repo.persons.set(defaultPerson.id, { ...defaultPerson });
    // Add page view event for activity
    repo.events.push({
      id: 'evt_1',
      site_id: 'sales-coach',
      person_id: 'per_1',
      event_name: 'page_view',
      path: '/#pricing',
      duration_seconds: 40,
      properties: '{}',
      timestamp: new Date().toISOString(),
      created_at: new Date().toISOString(),
    });

    mockAI = new MockAIProvider();
    mockSender = new MockEmailSender();

    pipeline = new DecisionPipeline({
      repo: repo as any,
      aiProvider: mockAI,
      emailSender: mockSender,
      signingSecret: 'test-signing-secret-key-123',
      appUrl: 'https://followup.refreshqueue.com',
    });
  });

  it('Default go_live=OFF creates pending draft and does NOT auto-send', async () => {
    const site = repo.sites.get('sales-coach')!;
    expect(site.go_live).toBe(0);

    mockAI.mockResult = {
      decision: 'send',
      reason: 'High interest in pricing',
      persona: 'Technical Lead',
      confidence: 0.95, // High confidence, but go_live is OFF
      subject: 'Quick question about Sales Coach',
      body: 'Hi Alex,\n\nSaw you checking out pricing.\n\nBest,\nYehuda',
    };

    const person = repo.persons.get('per_1')!;
    const res = await pipeline.processPerson(site, person);

    expect(res.action).toBe('drafted');
    expect(mockSender.sentEmails).toHaveLength(0); // Zero emails sent

    const drafts = Array.from(repo.drafts.values());
    expect(drafts).toHaveLength(1);
    expect(drafts[0].status).toBe('pending');
    expect(drafts[0].ai_reason).toContain('Site go-live is OFF');
    // Verify compliance footer is present
    expect(drafts[0].body_text).toContain(site.physical_address);
    expect(drafts[0].body_text).toContain('/unsubscribe?site=sales-coach');
  });

  it('go_live=ON with high confidence (>= 0.8) auto-sends email immediately', async () => {
    const site = { ...repo.sites.get('sales-coach')!, go_live: 1 };
    repo.sites.set(site.id, site);

    mockAI.mockResult = {
      decision: 'send',
      reason: 'Visited integrations page with high engagement',
      persona: 'Lead Architect',
      confidence: 0.88, // >= 0.8 threshold
      subject: 'Integrations for Sales Coach',
      body: 'Hi Alex,\n\nSaw you exploring our integrations.\n\nBest,\nYehuda',
    };

    const person = repo.persons.get('per_1')!;
    const res = await pipeline.processPerson(site, person);

    expect(res.action).toBe('sent');
    expect(mockSender.sentEmails).toHaveLength(1);
    expect(mockSender.sentEmails[0].payload.to).toBe('prospect@acmecorp.com');

    // Draft recorded as 'sent'
    const drafts = Array.from(repo.drafts.values());
    expect(drafts).toHaveLength(1);
    expect(drafts[0].status).toBe('sent');

    // Sends table recorded
    expect(repo.sends).toHaveLength(1);
    expect(repo.sends[0].to_email).toBe('prospect@acmecorp.com');

    // Person last_emailed_at updated
    expect(person.last_emailed_at).toBeTruthy();
  });

  it('go_live=ON with lower confidence (< threshold) waits for approval as pending draft', async () => {
    const site = { ...repo.sites.get('sales-coach')!, go_live: 1, confidence_threshold: 0.85 };
    repo.sites.set(site.id, site);

    mockAI.mockResult = {
      decision: 'send',
      reason: 'Moderate engagement',
      persona: 'Visitor',
      confidence: 0.72, // Below 0.85 threshold!
      subject: 'Checking in',
      body: 'Hi Alex,\n\nChecking in.\n\nBest,\nYehuda',
    };

    const person = repo.persons.get('per_1')!;
    const res = await pipeline.processPerson(site, person);

    expect(res.action).toBe('drafted');
    expect(mockSender.sentEmails).toHaveLength(0); // Not auto-sent

    const drafts = Array.from(repo.drafts.values());
    expect(drafts[0].status).toBe('pending');
    expect(drafts[0].ai_reason).toContain('Confidence 0.72 < threshold 0.85');
  });

  it('skips without calling AI when recipient is suppressed', async () => {
    const site = repo.sites.get('sales-coach')!;
    repo.suppression.add('sales-coach:prospect@acmecorp.com');

    const person = repo.persons.get('per_1')!;
    const res = await pipeline.processPerson(site, person);

    expect(res.action).toBe('skipped');
    expect(res.reason).toBe('suppressed_address');
    expect(mockAI.calls).toHaveLength(0); // AI was never called!
  });

  it('skips without calling AI when recipient is a paying customer', async () => {
    const site = repo.sites.get('sales-coach')!;
    const customer = { ...repo.persons.get('per_1')!, is_customer: 1 };
    repo.persons.set(customer.id, customer);

    const res = await pipeline.processPerson(site, customer);

    expect(res.action).toBe('skipped');
    expect(res.reason).toBe('customer_or_paid');
    expect(mockAI.calls).toHaveLength(0);
  });

  it('approveAndSendDraft approves a pending draft and sends it', async () => {
    const site = repo.sites.get('sales-coach')!;
    const person = repo.persons.get('per_1')!;

    // Create a pending draft
    const draft = await repo.createDraft({
      siteId: site.id,
      personId: person.id,
      subject: 'Pending Draft Subject',
      bodyText: 'Hey Alex,\n\nWanted to follow up.\n\nBest,\nYehuda',
      status: 'pending',
      aiReason: 'High intent',
      aiConfidence: 0.75,
    });

    const sendRes = await pipeline.approveAndSendDraft(draft.id);
    expect(sendRes.success).toBe(true);
    expect(mockSender.sentEmails).toHaveLength(1);
    expect(mockSender.sentEmails[0].payload.subject).toBe('Pending Draft Subject');

    const updatedDraft = await repo.getDraftById(draft.id);
    expect(updatedDraft?.status).toBe('sent');
  });
});
