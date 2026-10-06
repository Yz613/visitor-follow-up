import type { Person } from '../types';

export interface HardRuleCheckParams {
  person: Person;
  internalDomains: string[];
  frequencyCapDays: number;
  isSuppressed: boolean;
  hasPendingDraft?: boolean;
  hasNewActivity?: boolean;
  now?: Date;
}

export interface HardRuleResult {
  canEmail: boolean;
  skipReason?: string;
}

/**
 * Hard rules in code, never left to the AI model:
 * 1. Never email anonymous visitors / invalid emails.
 * 2. Never email suppressed addresses.
 * 3. Skip internal domains configured per site.
 * 4. Skip people marked as customers or paid.
 * 5. Skip people who already replied.
 * 6. Frequency cap: max 1 email per person per N days (default 7, configurable).
 * 7. Skip if a pending draft already awaits review.
 * 8. Skip if no new activity has occurred since last email.
 */
export function evaluateHardRules(params: HardRuleCheckParams): HardRuleResult {
  const {
    person,
    internalDomains,
    frequencyCapDays,
    isSuppressed,
    hasPendingDraft = false,
    hasNewActivity = true,
    now = new Date(),
  } = params;

  // 1. Never email anonymous visitors or missing/invalid email
  if (!person.email || typeof person.email !== 'string') {
    return { canEmail: false, skipReason: 'anonymous_visitor_no_email' };
  }

  const cleanEmail = person.email.trim().toLowerCase();
  const atIndex = cleanEmail.indexOf('@');
  if (atIndex <= 0 || atIndex === cleanEmail.length - 1) {
    return { canEmail: false, skipReason: 'invalid_email_format' };
  }

  // 2. Never email suppressed addresses
  if (isSuppressed) {
    return { canEmail: false, skipReason: 'suppressed_address' };
  }

  // 3. Skip internal domains per site
  const emailDomain = cleanEmail.substring(atIndex + 1);
  const normalizedInternal = (internalDomains || []).map((d) => d.trim().toLowerCase().replace(/^@/, ''));
  if (normalizedInternal.some((d) => d && (emailDomain === d || emailDomain.endsWith('.' + d)))) {
    return { canEmail: false, skipReason: 'internal_domain' };
  }

  // 4. Skip people marked as customers or paid
  if (person.is_customer === 1) {
    return { canEmail: false, skipReason: 'customer_or_paid' };
  }

  // 5. Skip people who replied
  if (person.has_replied === 1) {
    return { canEmail: false, skipReason: 'already_replied' };
  }

  // 6. Frequency cap: max 1 email per person per N days
  if (person.last_emailed_at) {
    const lastEmailed = new Date(person.last_emailed_at);
    if (!isNaN(lastEmailed.getTime())) {
      const daysSince = (now.getTime() - lastEmailed.getTime()) / (1000 * 60 * 60 * 24);
      const capDays = Math.max(frequencyCapDays ?? 7, 1);
      if (daysSince < capDays) {
        return {
          canEmail: false,
          skipReason: `frequency_cap_exceeded (${daysSince.toFixed(1)} days < cap of ${capDays} days)`,
        };
      }
    }
  }

  // 7. Skip if a pending draft is already waiting for review
  if (hasPendingDraft) {
    return { canEmail: false, skipReason: 'pending_draft_exists' };
  }

  // 8. Skip if no new activity since last email
  if (!hasNewActivity) {
    return { canEmail: false, skipReason: 'no_new_activity_since_last_email' };
  }

  return { canEmail: true };
}
