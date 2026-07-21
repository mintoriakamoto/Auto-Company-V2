// SnapOG — reconcile DB tier state against Stripe (heals missed webhooks).
//
// Pure planning function: given the users we think are customers and the live
// subscription summaries from Stripe, compute the minimal set of tier changes
// to apply. If a webhook was ever dropped, this converges the DB to Stripe.

import { subscriptionGrant } from './metrics';
import type { Tier } from './types';

export interface ReconcileUser {
  id: string;
  stripe_customer_id: string | null;
  billing_tier: string | null;
}

export interface SubSummary {
  customer: string;
  status: string;
  priceId: string | undefined;
}

export interface TierChange {
  userId: string;
  tier: Tier;
}

const RANK: Record<Tier, number> = { free: 0, pro: 1, business: 2 };

function betterTier(a: Tier | undefined, b: Tier): Tier {
  if (!a) return b;
  return RANK[b] > RANK[a] ? b : a;
}

export function planReconciliation(
  users: ReconcileUser[],
  subs: SubSummary[],
  priceToTier: (priceId: string | undefined) => Tier | null
): TierChange[] {
  // Best granted tier per Stripe customer (a customer could hold >1 sub).
  const desired = new Map<string, Tier>();
  for (const s of subs) {
    if (!s.customer) continue;
    const grant = subscriptionGrant(s.status, priceToTier(s.priceId));
    desired.set(s.customer, betterTier(desired.get(s.customer), grant.tier));
  }

  const changes: TierChange[] = [];
  for (const u of users) {
    if (!u.stripe_customer_id) continue;
    const want = desired.get(u.stripe_customer_id) ?? 'free';
    if ((u.billing_tier ?? 'free') !== want) {
      changes.push({ userId: u.id, tier: want });
    }
  }
  return changes;
}
