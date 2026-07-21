import { describe, it, expect } from 'vitest';
import { planReconciliation, type ReconcileUser, type SubSummary } from '../src/reconcile';
import type { Tier } from '../src/types';

// price_pro -> pro, price_biz -> business, else null
const priceToTier = (p: string | undefined): Tier | null =>
  p === 'price_pro' ? 'pro' : p === 'price_biz' ? 'business' : null;

const ALLOW = { allowDowngrades: true };

describe('planReconciliation', () => {
  it('upgrades a user whose active sub the DB missed (always allowed)', () => {
    const users: ReconcileUser[] = [{ id: 'u1', stripe_customer_id: 'cus_1', billing_tier: 'free' }];
    const subs: SubSummary[] = [{ customer: 'cus_1', status: 'active', priceId: 'price_pro' }];
    expect(planReconciliation(users, subs, priceToTier)).toEqual([
      { userId: 'u1', tier: 'pro', status: 'active' },
    ]);
  });

  it('downgrades a gone subscription ONLY when downgrades are allowed', () => {
    const users: ReconcileUser[] = [{ id: 'u1', stripe_customer_id: 'cus_1', billing_tier: 'pro' }];
    const subs: SubSummary[] = [{ customer: 'cus_2', status: 'active', priceId: 'price_pro' }];
    // Default (allowDowngrades:false) — never downgrade on unconfirmed data.
    expect(planReconciliation(users, subs, priceToTier)).toEqual([]);
    // Explicitly allowed (complete + non-empty read).
    expect(planReconciliation(users, subs, priceToTier, ALLOW)).toEqual([
      { userId: 'u1', tier: 'free', status: 'canceled' },
    ]);
  });

  it('NEVER downgrades on an empty subscription list by default (mass-downgrade guard)', () => {
    const users: ReconcileUser[] = [
      { id: 'u1', stripe_customer_id: 'cus_1', billing_tier: 'pro' },
      { id: 'u2', stripe_customer_id: 'cus_2', billing_tier: 'business' },
    ];
    expect(planReconciliation(users, [], priceToTier)).toEqual([]);
  });

  it('keeps a past_due customer on their paid tier (grace)', () => {
    const users: ReconcileUser[] = [{ id: 'u1', stripe_customer_id: 'cus_1', billing_tier: 'pro' }];
    const subs: SubSummary[] = [{ customer: 'cus_1', status: 'past_due', priceId: 'price_pro' }];
    expect(planReconciliation(users, subs, priceToTier, ALLOW)).toEqual([]);
  });

  it('preserves the real Stripe status on an upgrade', () => {
    const users: ReconcileUser[] = [{ id: 'u1', stripe_customer_id: 'cus_1', billing_tier: 'free' }];
    const subs: SubSummary[] = [{ customer: 'cus_1', status: 'trialing', priceId: 'price_pro' }];
    expect(planReconciliation(users, subs, priceToTier)).toEqual([
      { userId: 'u1', tier: 'pro', status: 'trialing' },
    ]);
  });

  it('makes no change when DB already matches Stripe', () => {
    const users: ReconcileUser[] = [{ id: 'u1', stripe_customer_id: 'cus_1', billing_tier: 'business' }];
    const subs: SubSummary[] = [{ customer: 'cus_1', status: 'active', priceId: 'price_biz' }];
    expect(planReconciliation(users, subs, priceToTier, ALLOW)).toEqual([]);
  });

  it('picks the highest tier when a customer has multiple subs', () => {
    const users: ReconcileUser[] = [{ id: 'u1', stripe_customer_id: 'cus_1', billing_tier: 'free' }];
    const subs: SubSummary[] = [
      { customer: 'cus_1', status: 'active', priceId: 'price_pro' },
      { customer: 'cus_1', status: 'active', priceId: 'price_biz' },
    ];
    expect(planReconciliation(users, subs, priceToTier)).toEqual([
      { userId: 'u1', tier: 'business', status: 'active' },
    ]);
  });

  it('ignores users with no stripe customer', () => {
    const users: ReconcileUser[] = [{ id: 'u1', stripe_customer_id: null, billing_tier: 'free' }];
    expect(planReconciliation(users, [], priceToTier, ALLOW)).toEqual([]);
  });
});
