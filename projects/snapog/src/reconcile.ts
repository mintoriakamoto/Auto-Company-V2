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
  status: string; // the real Stripe status driving the change
}

export interface ReconcileOptions {
  // Only downgrade paying customers when we KNOW the Stripe read was complete
  // and non-empty. Absence from a partial/empty/errored list must never be
  // read as "canceled" — that would mass-downgrade the whole paid base.
  allowDowngrades: boolean;
}

const RANK: Record<Tier, number> = { free: 0, pro: 1, business: 2 };

export function planReconciliation(
  users: ReconcileUser[],
  subs: SubSummary[],
  priceToTier: (priceId: string | undefined) => Tier | null,
  opts: ReconcileOptions = { allowDowngrades: false }
): TierChange[] {
  // Best granted tier (and its status) per Stripe customer.
  const desired = new Map<string, { tier: Tier; status: string }>();
  for (const s of subs) {
    if (!s.customer) continue;
    const grant = subscriptionGrant(s.status, priceToTier(s.priceId));
    const cur = desired.get(s.customer);
    if (!cur || RANK[grant.tier] > RANK[cur.tier]) {
      desired.set(s.customer, { tier: grant.tier, status: s.status });
    }
  }

  const changes: TierChange[] = [];
  for (const u of users) {
    if (!u.stripe_customer_id) continue;
    const want = desired.get(u.stripe_customer_id);
    const wantTier: Tier = want?.tier ?? 'free';
    const current: Tier = (u.billing_tier as Tier) ?? 'free';
    if (wantTier === current) continue;

    const isDowngrade = RANK[wantTier] < RANK[current];
    if (isDowngrade && !opts.allowDowngrades) continue; // never downgrade on unconfirmed data

    changes.push({
      userId: u.id,
      tier: wantTier,
      // Preserve the real Stripe status; a customer absent from the list is a
      // confirmed cancellation only when downgrades are allowed.
      status: want?.status ?? 'canceled',
    });
  }
  return changes;
}
