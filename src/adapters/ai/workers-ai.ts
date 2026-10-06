import type { AIDecisionResult } from '../../types';
import type { AIProvider, PersonContext, SitePromptContext } from './interface';

export class WorkersAIProvider implements AIProvider {
  private aiBinding: any;
  private defaultModel: string;

  constructor(aiBinding: any, defaultModel = '@cf/cloudflare/clef') {
    this.aiBinding = aiBinding;
    this.defaultModel = defaultModel;
  }

  async decideAndDraft(
    siteContext: SitePromptContext,
    personContext: PersonContext,
    modelName?: string
  ): Promise<AIDecisionResult> {
    const model = modelName || this.defaultModel;

    const systemPrompt = `You are the automated visitor follow-up intelligence system for "${siteContext.siteName}".
Sender identity: ${siteContext.senderName} <${siteContext.senderEmail}>.

VOICE & TONE GUIDELINES:
${siteContext.voiceDescription || 'Friendly, concise founder tone. Plain text only. Zero marketing hype or buzzwords. Natural, helpful, authentic.'}

${siteContext.promptTemplate ? `CUSTOM SITE INSTRUCTIONS:\n${siteContext.promptTemplate}\n` : ''}

CRITICAL RULES FOR EMAIL DRAFTS:
1. Format: PLAIN TEXT ONLY. Do not use Markdown (**bold**, # headers), HTML, or bullet lists.
2. Length: STRICTLY under 120 words.
3. Content: Reference what features/pages they explored naturally, without being creepy or intrusive (e.g., "Saw you were looking at our integrations", NOT "You visited URL at 2:04pm for 35 seconds").
4. Call to Action: Exactly ONE clear, low-friction ask (e.g., "Would you like our integration guide, or would a 10-minute chat be helpful?").
5. Persona & Reason: Explain your reasoning and classify their persona.
6. If the person has minimal intent, no recent visits to meaningful pages, or looks like a bounce, output decision: "skip".

OUTPUT FORMAT:
You MUST respond with valid JSON ONLY (no commentary outside JSON):
{
  "decision": "send" | "skip",
  "reason": "1-2 sentence explanation of why we should follow up or skip",
  "persona": "Short label (e.g. Technical evaluator assessing CRM integrations)",
  "confidence": 0.85,
  "subject": "Subject line under 60 chars",
  "body": "Plain text email body under 120 words"
}`;

    const userPrompt = `Evaluate this returning visitor and decide whether to send a personalized follow-up email:

VISITOR DETAILS:
- Email: ${personContext.email}
- Source: ${personContext.emailSource}
- Company: ${personContext.companyName || 'Not specified'} (${personContext.companyDomain || 'N/A'})
- Traits/Data: ${JSON.stringify(personContext.traits || {})}
- Notes from host site: ${personContext.notes || 'None'}
- Total site activity events: ${personContext.totalEventsCount}

VISITOR PAGES & RECENT ACTIVITY:
${
  personContext.recentPages.length > 0
    ? personContext.recentPages
        .map(
          (p) =>
            `- Path: ${p.path} | Duration: ${p.durationSeconds}s | High Intent: ${p.isHighIntent ? 'YES' : 'NO'} | Time: ${p.timestamp}`
        )
        .join('\n')
    : 'No detailed page views recorded.'
}

High-intent pages visited: ${personContext.highIntentPagesVisited.join(', ') || 'None'}

PREVIOUS EMAILS SENT:
${
  personContext.pastEmailsSent.length > 0
    ? personContext.pastEmailsSent.map((e) => `- Sent on ${e.sentAt}: "${e.subject}"`).join('\n')
    : 'None yet'
}

Return your JSON decision and draft now.`;

    if (!this.aiBinding || typeof this.aiBinding.run !== 'function') {
      // In local dev without Workers AI binding, provide an intelligent heuristic fallback
      return this.heuristicFallback(siteContext, personContext);
    }

    try {
      const response = await this.aiBinding.run(model, {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.3,
        max_tokens: 600,
      });

      const responseText = typeof response === 'string' ? response : response?.response || response?.text || JSON.stringify(response);

      return this.parseJsonResponse(responseText, siteContext, personContext);
    } catch (err: any) {
      // Try fallback model if the primary model fails
      if (model !== '@cf/meta/llama-3.1-8b-instruct') {
        try {
          const fallbackRes = await this.aiBinding.run('@cf/meta/llama-3.1-8b-instruct', {
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            temperature: 0.3,
          });
          const text = typeof fallbackRes === 'string' ? fallbackRes : fallbackRes?.response || JSON.stringify(fallbackRes);
          return this.parseJsonResponse(text, siteContext, personContext);
        } catch {
          // ignore and fall through
        }
      }

      return this.heuristicFallback(siteContext, personContext);
    }
  }

  private parseJsonResponse(
    rawText: string,
    siteContext: SitePromptContext,
    personContext: PersonContext
  ): AIDecisionResult {
    try {
      // Clean possible markdown code fences
      let cleaned = rawText.trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
      }

      const parsed = JSON.parse(cleaned);

      const decision: 'send' | 'skip' = parsed.decision === 'send' ? 'send' : 'skip';
      const confidence = typeof parsed.confidence === 'number' ? Math.min(Math.max(parsed.confidence, 0), 1) : 0.75;
      const reason = String(parsed.reason || 'Evaluated visitor activity history');
      const persona = String(parsed.persona || 'Interested visitor');

      let subject = parsed.subject ? String(parsed.subject).trim() : `Quick note from ${siteContext.senderName}`;
      let body = parsed.body ? String(parsed.body).trim() : '';

      // Verify plain text rules
      if (body) {
        body = body.replace(/[*_#`]/g, ''); // strip markdown styling
      }

      return {
        decision,
        reason,
        persona,
        confidence,
        subject,
        body,
      };
    } catch {
      return this.heuristicFallback(siteContext, personContext);
    }
  }

  private heuristicFallback(
    siteContext: SitePromptContext,
    personContext: PersonContext
  ): AIDecisionResult {
    const hasHighIntent = personContext.highIntentPagesVisited.length > 0;
    const name = personContext.traits?.name || personContext.traits?.first_name || '';
    const salutation = name ? `Hi ${name},` : 'Hi there,';

    if (hasHighIntent) {
      const topPage = personContext.highIntentPagesVisited[0];
      const pageTopic = topPage.includes('pricing')
        ? 'pricing options'
        : topPage.includes('integration')
        ? 'our integrations'
        : topPage.includes('calc')
        ? 'the cost calculator'
        : 'our platform';

      return {
        decision: 'send',
        reason: `Visitor explored high-intent page (${topPage}) and provided email via ${personContext.emailSource}.`,
        persona: 'High-intent returning evaluator',
        confidence: 0.88,
        subject: `Quick question about ${siteContext.siteName}`,
        body: `${salutation}\n\nSaw you were checking out ${pageTopic} on our site earlier.\n\nDo you have any questions or would a quick 10-minute walkthrough be helpful?\n\nBest,\n${siteContext.senderName}`,
      };
    }

    if (personContext.totalEventsCount >= 2) {
      return {
        decision: 'send',
        reason: `Identified visitor with multiple visits via ${personContext.emailSource}.`,
        persona: 'Returning website visitor',
        confidence: 0.75,
        subject: `Following up from ${siteContext.siteName}`,
        body: `${salutation}\n\nNoticed you stopped by our site again recently.\n\nCan I help point you towards anything specific or answer any questions for you?\n\nBest,\n${siteContext.senderName}`,
      };
    }

    return {
      decision: 'skip',
      reason: 'Low engagement: insufficient high-intent page visits or return sessions.',
      persona: 'Casual browser',
      confidence: 0.9,
    };
  }
}
