import type {
  AnalyticsConnector,
  DiscoveredEvent,
  DiscoveredPerson,
  SiteAnalyticsConfig,
  SyncResult,
} from './interface';

export class PostHogConnector implements AnalyticsConnector {
  readonly name = 'posthog';

  async sync(config: SiteAnalyticsConfig): Promise<SyncResult> {
    if (!config.apiKey || !config.projectId) {
      return {
        success: false,
        persons: [],
        events: [],
        errors: ['PostHog Personal API Key and Project ID are required.'],
      };
    }

    const host = (config.host || 'https://us.i.posthog.com').replace(/\/+$/, '');
    const projectId = encodeURIComponent(config.projectId);
    const authHeader = { Authorization: `Bearer ${config.apiKey}` };
    const errors: string[] = [];

    const discoveredPersons: DiscoveredPerson[] = [];
    const personMap = new Map<string, DiscoveredPerson>(); // distinctId -> DiscoveredPerson

    // 1. Fetch Persons from PostHog
    try {
      const personsUrl = new URL(`${host}/api/projects/${projectId}/persons/`);
      personsUrl.searchParams.set('limit', '100');

      const personsRes = await fetch(personsUrl.toString(), {
        headers: authHeader,
      });

      if (!personsRes.ok) {
        errors.push(`Failed to fetch PostHog persons: HTTP ${personsRes.status} ${personsRes.statusText}`);
      } else {
        const personsData = (await personsRes.json().catch(() => null)) as any;
        const results = personsData?.results || [];

        for (const p of results) {
          const props = p.properties || {};
          const distinctIds: string[] = Array.isArray(p.distinct_ids) ? p.distinct_ids : [];

          // Look for an email property or distinct_id that is an email
          let email: string | undefined = props.email || props.$email;
          if (!email) {
            const emailId = distinctIds.find((id) => typeof id === 'string' && id.includes('@') && !id.startsWith('$'));
            if (emailId) email = emailId;
          }

          if (email && typeof email === 'string') {
            const cleanEmail = email.trim().toLowerCase();
            const person: DiscoveredPerson = {
              email: cleanEmail,
              distinctId: distinctIds[0] || cleanEmail,
              traits: props,
              emailSource: 'posthog',
              companyName: props.company_name || props.company || props['$initial_company_name'] || null,
              companyDomain: props.company_domain || props['$initial_company_domain'] || null,
              lastSeenAt: p.created_at || new Date().toISOString(),
            };
            discoveredPersons.push(person);

            // Map all distinct_ids to this person
            for (const did of distinctIds) {
              personMap.set(did, person);
            }
            personMap.set(cleanEmail, person);
          }
        }
      }
    } catch (err: any) {
      errors.push(`PostHog persons fetch error: ${err?.message || String(err)}`);
    }

    // 2. Fetch Events from PostHog
    const discoveredEvents: DiscoveredEvent[] = [];
    try {
      const eventsUrl = new URL(`${host}/api/projects/${projectId}/events/`);
      eventsUrl.searchParams.set('limit', '100');
      if (config.sinceTimestamp) {
        eventsUrl.searchParams.set('after', config.sinceTimestamp);
      }

      const eventsRes = await fetch(eventsUrl.toString(), {
        headers: authHeader,
      });

      if (!eventsRes.ok) {
        errors.push(`Failed to fetch PostHog events: HTTP ${eventsRes.status} ${eventsRes.statusText}`);
      } else {
        const eventsData = (await eventsRes.json().catch(() => null)) as any;
        const results = eventsData?.results || [];

        for (const e of results) {
          const distinctId = e.distinct_id;
          const matchedPerson = distinctId ? personMap.get(distinctId) : undefined;
          const props = e.properties || {};

          const email = matchedPerson?.email || (typeof props.email === 'string' ? props.email.toLowerCase() : null);

          // Extract standard PostHog event properties
          const url = props['$current_url'] || props.url || null;
          const pathname = props['$pathname'] || (url ? new URL(url, 'http://localhost').pathname : null);
          const referrer = props['$referrer'] || props.referrer || null;
          const durationSeconds = props['$session_duration'] || props.duration_seconds || 0;

          discoveredEvents.push({
            distinctId: distinctId || 'anonymous',
            email: email || null,
            eventName: e.event || 'unknown',
            url: url ? String(url) : null,
            path: pathname ? String(pathname) : null,
            referrer: referrer ? String(referrer) : null,
            durationSeconds: typeof durationSeconds === 'number' ? durationSeconds : 0,
            properties: props,
            timestamp: e.timestamp || new Date().toISOString(),
          });
        }
      }
    } catch (err: any) {
      errors.push(`PostHog events fetch error: ${err?.message || String(err)}`);
    }

    return {
      success: errors.length === 0 || discoveredPersons.length > 0 || discoveredEvents.length > 0,
      persons: discoveredPersons,
      events: discoveredEvents,
      newCursor: new Date().toISOString(),
      errors: errors.length > 0 ? errors : undefined,
    };
  }
}
