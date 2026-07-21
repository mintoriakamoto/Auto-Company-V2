import { describe, it, expect } from 'vitest';
import {
  computeMetrics,
  computeFunnel,
  normalizeSource,
  subscriptionGrant,
  type UserRow,
  type FunnelEventRow,
} from '../src/metrics';

describe('normalizeSource', () => {
  it('slugifies and lowercases', () => {
    expect(normalizeSource('Product Hunt')).toBe('product-hunt');
    expect(normalizeSource('  Reddit/r_saas  ')).toBe('reddit-r_saas');
  });

  it('falls back to direct for empty/unknown', () => {
    expect(normalizeSource(null)).toBe('direct');
    expect(normalizeSource('')).toBe('direct');
    expect(normalizeSource('###')).toBe('direct');
  });

  it('caps length', () => {
    expect(normalizeSource('x'.repeat(100)).length).toBe(40);
  });
});

describe('computeMetrics', () => {
  const rows: UserRow[] = [
    { source: 'producthunt', billing_tier: 'pro' },       // $19
    { source: 'producthunt', billing_tier: 'free' },
    { source: 'reddit', billing_tier: 'business' },        // $49
    { source: 'reddit', billing_tier: 'free' },
    { source: null, billing_tier: 'free' },                // direct
  ];

  it('computes totals, MRR, and conversion rate', () => {
    const m = computeMetrics(rows);
    expect(m.signups).toBe(5);
    expect(m.paying_customers).toBe(2);
    expect(m.mrr_usd).toBe(68); // 19 + 49
    expect(m.conversion_rate).toBeCloseTo(2 / 5);
  });

  it('breaks down by source, sorted by MRR', () => {
    const m = computeMetrics(rows);
    expect(m.by_source[0]).toEqual({ source: 'reddit', signups: 2, paying: 1, mrr_usd: 49 });
    expect(m.by_source[1]).toEqual({ source: 'producthunt', signups: 2, paying: 1, mrr_usd: 19 });
    expect(m.by_source[2]).toEqual({ source: 'direct', signups: 1, paying: 0, mrr_usd: 0 });
  });

  it('handles an empty user base without dividing by zero', () => {
    const m = computeMetrics([]);
    expect(m.signups).toBe(0);
    expect(m.conversion_rate).toBe(0);
    expect(m.by_source).toEqual([]);
    expect(m.funnel.limit_reached).toBe(0);
  });
});

describe('computeFunnel', () => {
  const rows: FunnelEventRow[] = [
    { event: 'landing_viewed' },
    { event: 'landing_viewed' },
    { event: 'landing_viewed' },
    { event: 'landing_viewed' },
    { event: 'register_viewed' },
    { event: 'register_viewed' },
    { event: 'limit_reached' },
    { event: 'limit_reached' },
    { event: 'limit_reached' },
    { event: 'limit_reached' },
    { event: 'checkout_started' },
    { event: 'checkout_started' },
    { event: 'converted' },
    { event: 'noise' }, // ignored
  ];

  it('counts stages and computes stage-to-stage rates, including the top', () => {
    const f = computeFunnel(rows);
    expect(f.landing_viewed).toBe(4);
    expect(f.register_viewed).toBe(2);
    expect(f.limit_reached).toBe(4);
    expect(f.checkout_started).toBe(2);
    expect(f.converted).toBe(1);
    expect(f.landing_to_register).toBeCloseTo(0.5); // 2/4 — top-of-funnel leak now visible
    expect(f.limit_to_checkout).toBeCloseTo(0.5); // 2/4
    expect(f.checkout_to_paid).toBeCloseTo(0.5); // 1/2
  });

  it('avoids divide-by-zero on empty stages', () => {
    const f = computeFunnel([]);
    expect(f.landing_to_register).toBe(0);
    expect(f.limit_to_checkout).toBe(0);
    expect(f.checkout_to_paid).toBe(0);
  });
});

describe('subscriptionGrant (dunning grace)', () => {
  it('grants the paid tier while active or trialing', () => {
    expect(subscriptionGrant('active', 'pro')).toEqual({ tier: 'pro', status: 'active' });
    expect(subscriptionGrant('trialing', 'business')).toEqual({
      tier: 'business',
      status: 'trialing',
    });
  });

  it('keeps the tier through past_due (grace window)', () => {
    expect(subscriptionGrant('past_due', 'pro')).toEqual({ tier: 'pro', status: 'past_due' });
  });

  it('downgrades to free once Stripe gives up', () => {
    expect(subscriptionGrant('canceled', 'pro').tier).toBe('free');
    expect(subscriptionGrant('unpaid', 'pro').tier).toBe('free');
    expect(subscriptionGrant('incomplete_expired', 'business').tier).toBe('free');
  });

  it('never grants a paid tier without a resolved price', () => {
    expect(subscriptionGrant('active', null).tier).toBe('free');
    expect(subscriptionGrant('active', 'free').tier).toBe('free');
  });
});

describe('at-risk customers', () => {
  it('counts paying customers whose payment is failing', () => {
    const rows: UserRow[] = [
      { source: 'x', billing_tier: 'pro', billing_status: 'active' },
      { source: 'x', billing_tier: 'pro', billing_status: 'past_due' }, // at risk
      { source: 'x', billing_tier: 'business', billing_status: 'unpaid' }, // at risk
      { source: 'x', billing_tier: 'free', billing_status: 'none' },
    ];
    const m = computeMetrics(rows);
    expect(m.paying_customers).toBe(3);
    expect(m.at_risk_customers).toBe(2);
  });
});
