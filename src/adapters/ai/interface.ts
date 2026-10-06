import type { AIDecisionResult } from '../../types';

export interface PageActivity {
  path: string;
  url?: string;
  durationSeconds: number;
  isHighIntent: boolean;
  timestamp: string;
}

export interface PersonContext {
  email: string;
  traits: Record<string, any>;
  emailSource: string;
  companyName?: string | null;
  companyDomain?: string | null;
  notes?: string | null;
  totalEventsCount: number;
  recentPages: PageActivity[];
  highIntentPagesVisited: string[];
  pastEmailsSent: Array<{ sentAt: string; subject: string }>;
}

export interface SitePromptContext {
  siteName: string;
  senderName: string;
  senderEmail: string;
  promptTemplate?: string | null;
  voiceDescription?: string | null;
  highIntentPages: string[];
}

export interface AIProvider {
  decideAndDraft(
    siteContext: SitePromptContext,
    personContext: PersonContext,
    modelName?: string
  ): Promise<AIDecisionResult>;
}
