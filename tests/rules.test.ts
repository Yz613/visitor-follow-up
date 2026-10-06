import { describe, expect, it } from 'vitest';
import { evaluateHardRules } from '../src/core/rules';
import type { Person } from '../src/types';

describe('Hard Rules Engine (Code-level guarantees, never left to LLM)', () => {
  const basePerson: Person = {
    id: 'per_123',
    site_id: 'sales-coach',
    email: 'prospect@acmecorp.com',
    traits: '{}',
    email_source: 'form:integration-request',
    is_customer: 0,
    has_replied: 0,
    last_seen_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  it('rejects anonymous visitors or missing email', () => {
    const anonymousPerson = { ...basePerson, email: '' };
    const res = evaluateHardRules({
      person: anonymousPerson,
      internalDomains: ['refreshqueue.com'],
      frequencyCapDays: 7,
      isSuppressed: false,
    });
    expect(res.canEmail).toBe(false);
    expect(res.skipReason).toBe('anonymous_visitor_no_email');
  });

  it('rejects invalid email formats', () => {
    const invalidPerson = { ...basePerson, email: 'not-an-email' };
    const res = evaluateHardRules({
      person: invalidPerson,
      internalDomains: ['refreshqueue.com'],
      frequencyCapDays: 7,
      isSuppressed: false,
    });
    expect(res.canEmail).toBe(false);
    expect(res.skipReason).toBe('invalid_email_format');
  });

  it('never emails suppressed addresses', () => {
    const res = evaluateHardRules({
      person: basePerson,
      internalDomains: ['refreshqueue.com'],
      frequencyCapDays: 7,
      isSuppressed: true,
    });
    expect(res.canEmail).toBe(false);
    expect(res.skipReason).toBe('suppressed_address');
  });

  it('skips internal domains (exact and subdomains, case-insensitive)', () => {
    const internalPerson1 = { ...basePerson, email: 'yehuda@refreshqueue.com' };
    const res1 = evaluateHardRules({
      person: internalPerson1,
      internalDomains: ['refreshqueue.com'],
      frequencyCapDays: 7,
      isSuppressed: false,
    });
    expect(res1.canEmail).toBe(false);
    expect(res1.skipReason).toBe('internal_domain');

    const internalPerson2 = { ...basePerson, email: 'dev@staging.refreshqueue.com' };
    const res2 = evaluateHardRules({
      person: internalPerson2,
      internalDomains: ['refreshqueue.com'],
      frequencyCapDays: 7,
      isSuppressed: false,
    });
    expect(res2.canEmail).toBe(false);
    expect(res2.skipReason).toBe('internal_domain');
  });

  it('skips people marked as customers or paid', () => {
    const customer = { ...basePerson, is_customer: 1 };
    const res = evaluateHardRules({
      person: customer,
      internalDomains: ['refreshqueue.com'],
      frequencyCapDays: 7,
      isSuppressed: false,
    });
    expect(res.canEmail).toBe(false);
    expect(res.skipReason).toBe('customer_or_paid');
  });

  it('skips people who already replied', () => {
    const repliedPerson = { ...basePerson, has_replied: 1 };
    const res = evaluateHardRules({
      person: repliedPerson,
      internalDomains: ['refreshqueue.com'],
      frequencyCapDays: 7,
      isSuppressed: false,
    });
    expect(res.canEmail).toBe(false);
    expect(res.skipReason).toBe('already_replied');
  });

  it('enforces frequency cap (default 7 days)', () => {
    const now = new Date('2026-10-05T12:00:00Z');
    // Emailed 4 days ago (< 7 days cap)
    const recentEmail = new Date('2026-10-01T12:00:00Z').toISOString();
    const person = { ...basePerson, last_emailed_at: recentEmail };

    const res = evaluateHardRules({
      person,
      internalDomains: ['refreshqueue.com'],
      frequencyCapDays: 7,
      isSuppressed: false,
      now,
    });
    expect(res.canEmail).toBe(false);
    expect(res.skipReason).toContain('frequency_cap_exceeded');

    // Emailed 8 days ago (> 7 days cap)
    const oldEmail = new Date('2026-09-27T12:00:00Z').toISOString();
    const personEligible = { ...basePerson, last_emailed_at: oldEmail };

    const resEligible = evaluateHardRules({
      person: personEligible,
      internalDomains: ['refreshqueue.com'],
      frequencyCapDays: 7,
      isSuppressed: false,
      now,
    });
    expect(resEligible.canEmail).toBe(true);
  });

  it('enforces configurable frequency cap per site (e.g. 14 days or 3 days)', () => {
    const now = new Date('2026-10-05T12:00:00Z');
    const emailed5DaysAgo = new Date('2026-09-30T12:00:00Z').toISOString();
    const person = { ...basePerson, last_emailed_at: emailed5DaysAgo };

    // With 14 days cap -> rejected
    const res14 = evaluateHardRules({
      person,
      internalDomains: [],
      frequencyCapDays: 14,
      isSuppressed: false,
      now,
    });
    expect(res14.canEmail).toBe(false);
    expect(res14.skipReason).toContain('frequency_cap_exceeded');

    // With 3 days cap -> allowed
    const res3 = evaluateHardRules({
      person,
      internalDomains: [],
      frequencyCapDays: 3,
      isSuppressed: false,
      now,
    });
    expect(res3.canEmail).toBe(true);
  });

  it('skips when a pending draft already awaits approval', () => {
    const res = evaluateHardRules({
      person: basePerson,
      internalDomains: [],
      frequencyCapDays: 7,
      isSuppressed: false,
      hasPendingDraft: true,
    });
    expect(res.canEmail).toBe(false);
    expect(res.skipReason).toBe('pending_draft_exists');
  });

  it('skips when there is no new activity since last email', () => {
    const res = evaluateHardRules({
      person: basePerson,
      internalDomains: [],
      frequencyCapDays: 7,
      isSuppressed: false,
      hasNewActivity: false,
    });
    expect(res.canEmail).toBe(false);
    expect(res.skipReason).toBe('no_new_activity_since_last_email');
  });

  it('allows eligible identified visitor who meets all criteria', () => {
    const res = evaluateHardRules({
      person: basePerson,
      internalDomains: ['refreshqueue.com'],
      frequencyCapDays: 7,
      isSuppressed: false,
      hasPendingDraft: false,
      hasNewActivity: true,
    });
    expect(res.canEmail).toBe(true);
    expect(res.skipReason).toBeUndefined();
  });
});
