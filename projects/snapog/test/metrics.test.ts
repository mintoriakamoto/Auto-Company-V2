import { describe, it, expect } from 'vitest';
import { computeMetrics, normalizeSource, type UserRow } from '../src/metrics';

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
  });
});
