import { WorkersAIProvider } from '../adapters/ai/workers-ai';
import { PostHogConnector } from '../adapters/analytics/posthog';
import { ResendEmailSender } from '../adapters/email/resend';
import { DecisionPipeline } from '../core/pipeline';
import { DatabaseRepository } from '../db';
import type { Env } from '../types';

export async function handleScheduled(
  _event: ScheduledEvent,
  env: Env,
  _ctx: ExecutionContext
): Promise<void> {
  const repo = new DatabaseRepository(env.DB);
  const emailSender = new ResendEmailSender(env.RESEND_API_KEY);
  const aiProvider = new WorkersAIProvider(env.AI, env.AI_MODEL);

  const pipeline = new DecisionPipeline({
    repo,
    emailSender,
    aiProvider,
    signingSecret: env.SIGNING_SECRET || 'secret',
    appUrl: env.APP_URL || 'http://localhost:8787',
  });

  const sites = await repo.listSites();
  const connector = new PostHogConnector();

  for (const site of sites) {
    try {
      // 1. Sync PostHog if configured for this site
      if (site.posthog_api_key && site.posthog_project_id) {
        const syncRes = await connector.sync({
          siteId: site.id,
          apiKey: site.posthog_api_key,
          projectId: site.posthog_project_id,
          host: site.posthog_host,
          sinceTimestamp: site.posthog_last_sync_at,
        });

        for (const person of syncRes.persons) {
          await repo.upsertPerson({
            siteId: site.id,
            email: person.email,
            traits: person.traits,
            emailSource: 'posthog',
            companyName: person.companyName,
            companyDomain: person.companyDomain,
          });
        }

        for (const evt of syncRes.events) {
          let personId: string | null = null;
          if (evt.email) {
            const found = await repo.getPersonByEmail(site.id, evt.email);
            if (found) personId = found.id;
          }

          await repo.recordEvent({
            siteId: site.id,
            personId,
            anonymousId: evt.distinctId,
            eventName: evt.eventName,
            url: evt.url,
            path: evt.path,
            referrer: evt.referrer,
            durationSeconds: evt.durationSeconds,
            properties: evt.properties,
            timestamp: evt.timestamp,
          });
        }

        if (syncRes.newCursor) {
          await repo.updateSite(site.id, { posthog_last_sync_at: syncRes.newCursor } as any);
        }

        await repo.recordAuditLog(site.id, 'sync.posthog_cron', 'cron', {
          personsFound: syncRes.persons.length,
          eventsFound: syncRes.events.length,
        });
      }

      // 2. Evaluate persons with new activity through Decision Pipeline
      const pipelineRes = await pipeline.processSite(site, 50);

      await repo.recordAuditLog(site.id, 'cron.pipeline_run', 'cron', pipelineRes);
    } catch (err: any) {
      console.error(`Error processing site ${site.id} during scheduled cron:`, err);
      try {
        await repo.recordAuditLog(site.id, 'cron.error', 'cron', {
          error: err?.message || String(err),
        });
      } catch {
        // ignore logging failure
      }
    }
  }
}
