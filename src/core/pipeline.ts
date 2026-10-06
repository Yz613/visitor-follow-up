import type { AIProvider, PageActivity, PersonContext, SitePromptContext } from '../adapters/ai/interface';
import type { EmailSender } from '../adapters/email/interface';
import type { DatabaseRepository } from '../db';
import type { Draft, Person, Site } from '../types';
import { evaluateHardRules } from './rules';
import { buildUnsubscribeUrl } from './tokens';
import { dispatchWebhook } from './webhooks';

export interface PipelineOptions {
  repo: DatabaseRepository;
  aiProvider: AIProvider;
  emailSender: EmailSender;
  signingSecret: string;
  appUrl: string;
}

export interface ProcessPersonResult {
  action: 'sent' | 'drafted' | 'skipped' | 'failed';
  reason?: string;
  draftId?: string;
  confidence?: number;
}

export class DecisionPipeline {
  private repo: DatabaseRepository;
  private aiProvider: AIProvider;
  private emailSender: EmailSender;
  private signingSecret: string;
  private appUrl: string;

  constructor(options: PipelineOptions) {
    this.repo = options.repo;
    this.aiProvider = options.aiProvider;
    this.emailSender = options.emailSender;
    this.signingSecret = options.signingSecret;
    this.appUrl = options.appUrl;
  }

  /**
   * Evaluates a single identified person, executes hard rules, calls AI if eligible,
   * and either creates a pending draft or auto-sends if site.go_live is ON with high confidence.
   */
  async processPerson(site: Site, person: Person): Promise<ProcessPersonResult> {
    // 1. Gather site configurations
    let internalDomains: string[] = [];
    try {
      internalDomains = JSON.parse(site.internal_domains || '[]');
    } catch {
      internalDomains = [];
    }

    let highIntentList: string[] = [];
    try {
      highIntentList = JSON.parse(site.high_intent_pages || '[]');
    } catch {
      highIntentList = [];
    }

    // 2. Check Suppression & Pending Drafts in DB
    const isSuppressed = await this.repo.isEmailSuppressed(site.id, person.email);
    const hasPendingDraft = await this.repo.hasPendingDraft(site.id, person.id);

    // 3. Check for new activity
    const events = await this.repo.getEventsForPerson(site.id, person.id, 50);
    const hasNewActivity =
      events.length > 0 &&
      (!person.last_emailed_at ||
        events.some((e) => new Date(e.timestamp) > new Date(person.last_emailed_at!)));

    // 4. Evaluate Hard Rules in code (NEVER delegated to LLM)
    const ruleEvaluation = evaluateHardRules({
      person,
      internalDomains,
      frequencyCapDays: site.frequency_cap_days ?? 7,
      isSuppressed,
      hasPendingDraft,
      hasNewActivity,
    });

    if (!ruleEvaluation.canEmail) {
      await this.repo.recordAuditLog(site.id, 'rule.skipped', 'system', {
        email: person.email,
        personId: person.id,
        reason: ruleEvaluation.skipReason,
      });
      return { action: 'skipped', reason: ruleEvaluation.skipReason };
    }

    // 5. Build context for AI decision
    const recentPages: PageActivity[] = [];
    const highIntentVisited = new Set<string>();

    for (const evt of events) {
      const path = evt.path || (evt.url ? new URL(evt.url, 'http://localhost').pathname : '');
      const isHighIntent = highIntentList.some((pattern) => {
        if (!pattern || !path) return false;
        return path === pattern || path.startsWith(pattern) || path.includes(pattern);
      });

      if (isHighIntent && path) {
        highIntentVisited.add(path);
      }

      if (path) {
        recentPages.push({
          path,
          url: evt.url || undefined,
          durationSeconds: evt.duration_seconds || 0,
          isHighIntent,
          timestamp: evt.timestamp,
        });
      }
    }

    let parsedTraits: Record<string, any> = {};
    try {
      parsedTraits = JSON.parse(person.traits || '{}');
    } catch {
      parsedTraits = {};
    }

    const pastSends = await this.repo.listSends(site.id, 5);
    const personPastSends = pastSends
      .filter((s) => s.person_id === person.id)
      .map((s) => ({ sentAt: s.sent_at, subject: s.subject }));

    const siteContext: SitePromptContext = {
      siteName: site.name,
      senderName: site.sender_name,
      senderEmail: site.sender_email,
      promptTemplate: site.prompt_template,
      voiceDescription: site.voice_description,
      highIntentPages: highIntentList,
    };

    const personContext: PersonContext = {
      email: person.email,
      traits: parsedTraits,
      emailSource: person.email_source,
      companyName: person.company_name,
      companyDomain: person.company_domain,
      notes: person.notes,
      totalEventsCount: events.length,
      recentPages: recentPages.slice(0, 10),
      highIntentPagesVisited: Array.from(highIntentVisited),
      pastEmailsSent: personPastSends,
    };

    // 6. Call AI Provider for decision and draft
    const aiDecision = await this.aiProvider.decideAndDraft(siteContext, personContext);

    if (aiDecision.decision === 'skip') {
      await this.repo.recordAuditLog(site.id, 'ai.skipped', 'system', {
        email: person.email,
        personId: person.id,
        reason: aiDecision.reason,
        persona: aiDecision.persona,
        confidence: aiDecision.confidence,
      });
      return { action: 'skipped', reason: aiDecision.reason, confidence: aiDecision.confidence };
    }

    // 7. Format email body with CAN-SPAM physical address footer and unsubscribe link
    const unsubscribeUrl = await buildUnsubscribeUrl(this.appUrl, site.id, person.email, this.signingSecret);
    const rawBody = (aiDecision.body || '').trim();
    const finalBodyText = this.appendComplianceFooter(
      rawBody,
      site.sender_name,
      site.physical_address,
      unsubscribeUrl
    );
    const subject = aiDecision.subject || `Quick question from ${site.sender_name}`;

    const activitySummary = `Explored ${recentPages.length} pages (${Array.from(highIntentVisited).join(', ') || 'general visits'})`;

    // 8. Go-live switch check:
    // Default OFF (0) = drafts only.
    // ON (1) = high-confidence drafts (>= confidence_threshold) auto-send; rest wait for approval.
    const isGoLive = site.go_live === 1;
    const threshold = site.confidence_threshold ?? 0.8;
    const isHighConfidence = aiDecision.confidence >= threshold;
    const shouldAutoSend = isGoLive && isHighConfidence;

    if (shouldAutoSend) {
      // Auto-send directly
      const sendRes = await this.emailSender.send(
        {
          to: person.email,
          fromName: site.sender_name,
          fromEmail: site.sender_email,
          replyTo: site.reply_to || undefined,
          subject,
          bodyText: finalBodyText,
          unsubscribeUrl,
        },
        site.resend_api_key || undefined
      );

      if (sendRes.success) {
        // Create draft record as 'sent'
        const draft = await this.repo.createDraft({
          siteId: site.id,
          personId: person.id,
          subject,
          bodyText: finalBodyText,
          status: 'sent',
          aiDecision: 'send',
          aiReason: aiDecision.reason,
          aiConfidence: aiDecision.confidence,
          aiPersona: aiDecision.persona,
          activitySummary,
        });

        // Record in sends table
        await this.repo.recordSend({
          siteId: site.id,
          personId: person.id,
          draftId: draft.id,
          toEmail: person.email,
          fromEmail: site.sender_email,
          subject,
          bodyText: finalBodyText,
          provider: site.email_provider || 'resend',
          providerMessageId: sendRes.messageId,
          status: 'sent',
        });

        // Update last emailed timestamp to enforce frequency cap
        await this.repo.updateLastEmailed(person.id);

        // Audit log & Webhook
        await this.repo.recordAuditLog(site.id, 'email.sent', 'system (auto-send)', {
          draftId: draft.id,
          toEmail: person.email,
          subject,
          confidence: aiDecision.confidence,
        });

        await dispatchWebhook(site.webhook_url, site.webhook_secret, {
          event: 'email.sent',
          siteId: site.id,
          timestamp: new Date().toISOString(),
          data: {
            draftId: draft.id,
            toEmail: person.email,
            subject,
            provider: site.email_provider,
            providerMessageId: sendRes.messageId,
          },
        });

        return { action: 'sent', draftId: draft.id, confidence: aiDecision.confidence };
      } else {
        // Send failed; fallback to pending draft
        const draft = await this.repo.createDraft({
          siteId: site.id,
          personId: person.id,
          subject,
          bodyText: finalBodyText,
          status: 'pending',
          aiDecision: 'send',
          aiReason: `Auto-send failed: ${sendRes.error}. Saved as pending draft.`,
          aiConfidence: aiDecision.confidence,
          aiPersona: aiDecision.persona,
          activitySummary,
        });

        await this.repo.recordAuditLog(site.id, 'email.send_failed', 'system', {
          draftId: draft.id,
          error: sendRes.error,
        });

        return { action: 'failed', draftId: draft.id, reason: sendRes.error };
      }
    }

    // Not auto-sending (go_live is OFF or confidence < threshold): create pending draft
    const draft = await this.repo.createDraft({
      siteId: site.id,
      personId: person.id,
      subject,
      bodyText: finalBodyText,
      status: 'pending',
      aiDecision: 'send',
      aiReason: isGoLive
        ? `${aiDecision.reason} (Confidence ${aiDecision.confidence.toFixed(2)} < threshold ${threshold.toFixed(2)})`
        : `${aiDecision.reason} (Site go-live is OFF)`,
      aiConfidence: aiDecision.confidence,
      aiPersona: aiDecision.persona,
      activitySummary,
    });

    await this.repo.recordAuditLog(site.id, 'draft.created', 'system', {
      draftId: draft.id,
      toEmail: person.email,
      subject,
      confidence: aiDecision.confidence,
      persona: aiDecision.persona,
    });

    await dispatchWebhook(site.webhook_url, site.webhook_secret, {
      event: 'draft.created',
      siteId: site.id,
      timestamp: new Date().toISOString(),
      data: {
        draftId: draft.id,
        toEmail: person.email,
        subject,
        confidence: aiDecision.confidence,
        persona: aiDecision.persona,
      },
    });

    return { action: 'drafted', draftId: draft.id, confidence: aiDecision.confidence };
  }

  /**
   * Approves a pending draft and sends it out.
   */
  async approveAndSendDraft(
    draftId: string,
    customSubject?: string,
    customBodyText?: string,
    actor = 'admin'
  ): Promise<{ success: boolean; error?: string }> {
    const draft = await this.repo.getDraftById(draftId);
    if (!draft) return { success: false, error: 'Draft not found' };
    if (draft.status !== 'pending') {
      return { success: false, error: `Draft is already ${draft.status}` };
    }

    const site = await this.repo.getSiteById(draft.site_id);
    if (!site) return { success: false, error: 'Site not found' };

    const person = await this.repo.getPersonById(draft.person_id);
    if (!person) return { success: false, error: 'Person not found' };

    // Check suppression before manual send
    if (await this.repo.isEmailSuppressed(site.id, person.email)) {
      await this.repo.updateDraft(draftId, { status: 'skipped' });
      return { success: false, error: 'Cannot send: recipient has unsubscribed or is suppressed.' };
    }

    const subjectToSend = customSubject || draft.subject;
    let bodyToSend = customBodyText || draft.body_text;

    // Ensure compliance footer is present
    const unsubscribeUrl = await buildUnsubscribeUrl(this.appUrl, site.id, person.email, this.signingSecret);
    if (!bodyToSend.includes(unsubscribeUrl) && !bodyToSend.includes('/unsubscribe')) {
      bodyToSend = this.appendComplianceFooter(bodyToSend, site.sender_name, site.physical_address, unsubscribeUrl);
    }

    const sendRes = await this.emailSender.send(
      {
        to: person.email,
        fromName: site.sender_name,
        fromEmail: site.sender_email,
        replyTo: site.reply_to || undefined,
        subject: subjectToSend,
        bodyText: bodyToSend,
        unsubscribeUrl,
      },
      site.resend_api_key || undefined
    );

    if (!sendRes.success) {
      await this.repo.recordAuditLog(site.id, 'send.failed', actor, {
        draftId,
        error: sendRes.error,
      });
      return { success: false, error: sendRes.error };
    }

    // Update draft to 'sent'
    await this.repo.updateDraft(draftId, {
      status: 'sent',
      subject: subjectToSend,
      bodyText: bodyToSend,
    });

    // Record send
    await this.repo.recordSend({
      siteId: site.id,
      personId: person.id,
      draftId,
      toEmail: person.email,
      fromEmail: site.sender_email,
      subject: subjectToSend,
      bodyText: bodyToSend,
      provider: site.email_provider || 'resend',
      providerMessageId: sendRes.messageId,
      status: 'sent',
    });

    // Update last emailed
    await this.repo.updateLastEmailed(person.id);

    // Audit log & Webhook
    await this.repo.recordAuditLog(site.id, 'draft.approved_and_sent', actor, {
      draftId,
      toEmail: person.email,
      subject: subjectToSend,
    });

    await dispatchWebhook(site.webhook_url, site.webhook_secret, {
      event: 'email.sent',
      siteId: site.id,
      timestamp: new Date().toISOString(),
      data: {
        draftId,
        toEmail: person.email,
        subject: subjectToSend,
        provider: site.email_provider,
        providerMessageId: sendRes.messageId,
      },
    });

    return { success: true };
  }

  /**
   * Rejects / Skips a pending draft
   */
  async rejectDraft(draftId: string, reason = 'Skipped by admin', actor = 'admin'): Promise<boolean> {
    const draft = await this.repo.getDraftById(draftId);
    if (!draft) return false;

    await this.repo.updateDraft(draftId, { status: 'skipped' });
    await this.repo.recordAuditLog(draft.site_id, 'draft.skipped', actor, {
      draftId,
      reason,
    });
    return true;
  }

  /**
   * Processes all candidates with new activity for a given site
   */
  async processSite(
    site: Site,
    limit = 50
  ): Promise<{ processed: number; drafted: number; sent: number; skipped: number }> {
    const candidates = await this.repo.getPersonsWithNewActivity(site.id, limit);
    let drafted = 0;
    let sent = 0;
    let skipped = 0;

    for (const person of candidates) {
      const res = await this.processPerson(site, person);
      if (res.action === 'sent') sent++;
      else if (res.action === 'drafted') drafted++;
      else skipped++;
    }

    return {
      processed: candidates.length,
      drafted,
      sent,
      skipped,
    };
  }

  private appendComplianceFooter(
    body: string,
    senderName: string,
    physicalAddress: string,
    unsubscribeUrl: string
  ): string {
    const trimmed = body.trim();
    return `${trimmed}\n\n--\n${senderName}\n${physicalAddress}\n\nUnsubscribe: ${unsubscribeUrl}`;
  }
}
