// SnapOG — growth metrics (ground truth for the autonomous loop)
//
// Aggregation is a pure function over DB rows so it is unit-testable without
// a live database. The HTTP handler in index.ts just feeds it query results.

import { TIER_PRICE_USD, type Tier } from './types';

export interface UserRow {
  source: string | null;
  billing_tier: string | null;
  billing_status?: string | null;
}

// Subscription statuses where we keep the paid tier: active/trialing are
// healthy; past_due is a grace window while Stripe retries the payment (its
// Smart Retries / dunning). Everything else drops the account to free.
const GRANT_STATUSES = new Set(['active', 'trialing', 'past_due']);
const AT_RISK_STATUSES = new Set(['past_due', 'incomplete', 'unpaid']);

export function subscriptionGrant(
  status: string,
  tier: Tier | null
): { tier: Tier; status: string } {
  if (tier && tier !== 'free' && GRANT_STATUSES.has(status)) {
    return { tier, status };
  }
  return { tier: 'free', status };
}

export interface SourceStat {
  source: string;
  signups: number;
  paying: number;
  mrr_usd: number;
}

export interface FunnelCounts {
  landing_viewed: number;
  register_viewed: number;
  limit_reached: number;
  checkout_started: number;
  converted: number;
}

export interface Funnel extends FunnelCounts {
  // Rates between stages, 0..1. Tell the loop where the leak is — including
  // the top of the funnel (visitors who never sign up), which was invisible.
  landing_to_register: number; // register_viewed / landing_viewed
  limit_to_checkout: number; // checkout_started / limit_reached
  checkout_to_paid: number; // converted / checkout_started
}

export interface Metrics {
  signups: number;
  paying_customers: number;
  at_risk_customers: number; // paying but payment failing (past_due/unpaid)
  mrr_usd: number;
  conversion_rate: number; // paying / signups, 0..1
  by_source: SourceStat[];
  funnel: Funnel;
}

export interface FunnelEventRow {
  event: string;
}

const FUNNEL_STAGES = [
  'landing_viewed',
  'register_viewed',
  'limit_reached',
  'checkout_started',
  'converted',
] as const;

export function computeFunnel(rows: FunnelEventRow[]): Funnel {
  const counts: FunnelCounts = {
    landing_viewed: 0,
    register_viewed: 0,
    limit_reached: 0,
    checkout_started: 0,
    converted: 0,
  };
  for (const row of rows) {
    if ((FUNNEL_STAGES as readonly string[]).includes(row.event)) {
      counts[row.event as keyof FunnelCounts] += 1;
    }
  }
  return {
    ...counts,
    landing_to_register:
      counts.landing_viewed > 0 ? counts.register_viewed / counts.landing_viewed : 0,
    limit_to_checkout:
      counts.limit_reached > 0 ? counts.checkout_started / counts.limit_reached : 0,
    checkout_to_paid:
      counts.checkout_started > 0 ? counts.converted / counts.checkout_started : 0,
  };
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

export function computeMetrics(rows: UserRow[], funnelRows: FunnelEventRow[] = []): Metrics {
  const bySource = new Map<string, SourceStat>();
  let signups = 0;
  let paying = 0;
  let atRisk = 0;
  let mrr = 0;

  for (const row of rows) {
    const source = normalizeSource(row.source);
    const price = tierPrice(row.billing_tier);
    const isPaying = price > 0;

    signups += 1;
    if (isPaying) {
      paying += 1;
      mrr += price;
      if (row.billing_status && AT_RISK_STATUSES.has(row.billing_status)) {
        atRisk += 1;
      }
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
    at_risk_customers: atRisk,
    mrr_usd: mrr,
    conversion_rate: signups > 0 ? paying / signups : 0,
    by_source,
    funnel: computeFunnel(funnelRows),
  };
}
