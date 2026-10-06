// Analytics connector interface for pulling identified persons and visitor events

export interface SiteAnalyticsConfig {
  siteId: string;
  apiKey: string;
  projectId?: string | null;
  host?: string | null; // e.g. 'https://us.i.posthog.com' or 'https://eu.i.posthog.com'
  sinceTimestamp?: string | null;
}

export interface DiscoveredPerson {
  email: string;
  distinctId: string;
  traits: Record<string, any>;
  emailSource: string;
  companyName?: string | null;
  companyDomain?: string | null;
  lastSeenAt: string;
}

export interface DiscoveredEvent {
  distinctId: string;
  email?: string | null;
  eventName: string;
  url?: string | null;
  path?: string | null;
  referrer?: string | null;
  durationSeconds?: number;
  properties: Record<string, any>;
  timestamp: string;
}

export interface SyncResult {
  success: boolean;
  persons: DiscoveredPerson[];
  events: DiscoveredEvent[];
  newCursor?: string | null;
  errors?: string[];
}

export interface AnalyticsConnector {
  readonly name: string;
  sync(config: SiteAnalyticsConfig): Promise<SyncResult>;
}
