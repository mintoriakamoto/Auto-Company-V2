// SnapOG — growth metrics (ground truth for the autonomous loop)
//
// Aggregation is a pure function over DB rows so it is unit-testable without
// a live database. The HTTP handler in index.ts just feeds it query results.

import { TIER_PRICE_USD, type Tier } from './types';

export interface UserRow {
  source: string | null;
  billing_tier: string | null;
}

export interface SourceStat {
  source: string;
  signups: number;
  paying: number;
  mrr_usd: number;
}

export interface Metrics {
  signups: number;
  paying_customers: number;
  mrr_usd: number;
  conversion_rate: number; // paying / signups, 0..1
  by_source: SourceStat[];
}

// Normalize an acquisition source into a short, safe slug. Anything unknown
// or empty becomes "direct". Keeps attribution keys clean and injection-safe.
export function normalizeSource(raw: string | null | undefined): string {
  if (!raw) return 'direct';
  const slug = raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'direct';
}

function tierPrice(tier: string | null): number {
  if (tier === 'pro' || tier === 'business' || tier === 'free') {
    return TIER_PRICE_USD[tier as Tier];
  }
  return 0;
}

export function computeMetrics(rows: UserRow[]): Metrics {
  const bySource = new Map<string, SourceStat>();
  let signups = 0;
  let paying = 0;
  let mrr = 0;

  for (const row of rows) {
    const source = normalizeSource(row.source);
    const price = tierPrice(row.billing_tier);
    const isPaying = price > 0;

    signups += 1;
    if (isPaying) {
      paying += 1;
      mrr += price;
    }

    let stat = bySource.get(source);
    if (!stat) {
      stat = { source, signups: 0, paying: 0, mrr_usd: 0 };
      bySource.set(source, stat);
    }
    stat.signups += 1;
    if (isPaying) {
      stat.paying += 1;
      stat.mrr_usd += price;
    }
  }

  const by_source = Array.from(bySource.values()).sort(
    (a, b) => b.mrr_usd - a.mrr_usd || b.signups - a.signups
  );

  return {
    signups,
    paying_customers: paying,
    mrr_usd: mrr,
    conversion_rate: signups > 0 ? paying / signups : 0,
    by_source,
  };
}
