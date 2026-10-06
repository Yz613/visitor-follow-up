import { describe, expect, it } from 'vitest';
import { MockAIProvider } from '../src/adapters/ai/mock';
import { WorkersAIProvider } from '../src/adapters/ai/workers-ai';
import { MockAnalyticsConnector } from '../src/adapters/analytics/mock';
import { PostHogConnector } from '../src/adapters/analytics/posthog';
import { MockEmailSender } from '../src/adapters/email/mock';
import { ResendEmailSender } from '../src/adapters/email/resend';

describe('Adapter Interfaces & Implementations', () => {
  describe('EmailSender Interface', () => {
    it('MockEmailSender records sent payloads and respects failure toggle', async () => {
      const mockSender = new MockEmailSender();
      const payload = {
        to: 'test@example.com',
        fromName: 'Yehuda',
        fromEmail: 'yehuda@refreshqueue.com',
        subject: 'Quick question',
        bodyText: 'Hey there,\n\nSaw you on our site.',
        unsubscribeUrl: 'https://example.com/unsubscribe?token=abc',
      };

      const res = await mockSender.send(payload, 'key_123');
      expect(res.success).toBe(true);
      expect(res.messageId).toContain('mock_msg_');
      expect(mockSender.sentEmails).toHaveLength(1);
      expect(mockSender.sentEmails[0].payload.to).toBe('test@example.com');

      // Failure simulation
      mockSender.shouldFail = true;
      const failRes = await mockSender.send(payload);
      expect(failRes.success).toBe(false);
      expect(failRes.error).toBe(mockSender.failureMessage);
    });

    it('ResendEmailSender requires API key and sets List-Unsubscribe headers', async () => {
      const resend = new ResendEmailSender();
      const resWithoutKey = await resend.send({
        to: 'test@example.com',
        fromName: 'Yehuda',
        fromEmail: 'yehuda@refreshqueue.com',
        subject: 'Test',
        bodyText: 'Body',
        unsubscribeUrl: 'https://example.com/unsubscribe',
      });
      expect(resWithoutKey.success).toBe(false);
      expect(resWithoutKey.error).toContain('No Resend API key provided');
    });
  });

  describe('AnalyticsConnector Interface', () => {
    it('MockAnalyticsConnector returns mock persons and events', async () => {
      const mockConn = new MockAnalyticsConnector();
      mockConn.mockPersons = [
        {
          email: 'visitor@company.com',
          distinctId: 'anon_1',
          traits: { role: 'VP Sales' },
          emailSource: 'posthog',
          lastSeenAt: '2026-10-05T12:00:00Z',
        },
      ];
      mockConn.mockEvents = [
        {
          distinctId: 'anon_1',
          eventName: 'page_view',
          path: '/#pricing',
          properties: {},
          timestamp: '2026-10-05T12:00:00Z',
        },
      ];

      const res = await mockConn.sync({ siteId: 'site_1', apiKey: 'key_1', projectId: 'proj_1' });
      expect(res.success).toBe(true);
      expect(res.persons).toHaveLength(1);
      expect(res.events).toHaveLength(1);
      expect(res.persons[0].email).toBe('visitor@company.com');
    });

    it('PostHogConnector validates required credentials', async () => {
      const posthog = new PostHogConnector();
      const res = await posthog.sync({ siteId: 'site_1', apiKey: '', projectId: '' });
      expect(res.success).toBe(false);
      expect(res.errors?.[0]).toContain('required');
    });
  });

  describe('AIProvider Interface', () => {
    it('MockAIProvider returns deterministic structured result', async () => {
      const mockAI = new MockAIProvider();
      const siteContext = {
        siteName: 'Sales Coach',
        senderName: 'Yehuda',
        senderEmail: 'yehuda@refreshqueue.com',
        highIntentPages: ['/#pricing', '/integrations'],
      };
      const personContext = {
        email: 'prospect@acmecorp.com',
        traits: {},
        emailSource: 'form:integration-request',
        totalEventsCount: 3,
        recentPages: [],
        highIntentPagesVisited: ['/#pricing'],
        pastEmailsSent: [],
      };

      const result = await mockAI.decideAndDraft(siteContext, personContext);
      expect(result.decision).toBe('send');
      expect(result.confidence).toBeGreaterThan(0.8);
      expect(result.subject).toBeTruthy();
      expect(result.body).toBeTruthy();
      expect(mockAI.calls).toHaveLength(1);
    });

    it('WorkersAIProvider heuristic fallback provides plain-text compliant drafts', async () => {
      // Test the heuristic fallback when no binding is provided
      const provider = new WorkersAIProvider(null);
      const siteContext = {
        siteName: 'Sales Coach',
        senderName: 'Yehuda',
        senderEmail: 'yehuda@refreshqueue.com',
        highIntentPages: ['/#pricing'],
      };
      const personContext = {
        email: 'prospect@acmecorp.com',
        traits: { name: 'Sarah' },
        emailSource: 'form:integration-request',
        totalEventsCount: 4,
        recentPages: [],
        highIntentPagesVisited: ['/#pricing'],
        pastEmailsSent: [],
      };

      const result = await provider.decideAndDraft(siteContext, personContext);
      expect(result.decision).toBe('send');
      expect(result.body).toContain('Hi Sarah');
      expect(result.body).toContain('pricing options');
      // Verify word count is strictly under 120 words
      const wordCount = result.body!.trim().split(/\s+/).length;
      expect(wordCount).toBeLessThan(120);
      // Verify plain text (no markdown headings or bolding)
      expect(result.body).not.toContain('**');
      expect(result.body).not.toContain('###');
    });
  });
});
