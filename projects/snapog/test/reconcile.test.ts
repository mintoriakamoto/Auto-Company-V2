import { describe, it, expect } from 'vitest';
import { planReconciliation, type ReconcileUser, type SubSummary } from '../src/reconcile';
import type { Tier } from '../src/types';

// price_pro -> pro, price_biz -> business, else null
const priceToTier = (p: string | undefined): Tier | null =>
  p === 'price_pro' ? 'pro' : p === 'price_biz' ? 'business' : null;

describe('planReconciliation', () => {
  it('upgrades a user whose active sub the DB missed', () => {
    const users: ReconcileUser[] = [{ id: 'u1', stripe_customer_id: 'cus_1', billing_tier: 'free' }];
    const subs: SubSummary[] = [{ customer: 'cus_1', status: 'active', priceId: 'price_pro' }];
    expect(planReconciliation(users, subs, priceToTier)).toEqual([{ userId: 'u1', tier: 'pro' }]);
  });

  it('downgrades a user whose subscription is gone from Stripe', () => {
    const users: ReconcileUser[] = [{ id: 'u1', stripe_customer_id: 'cus_1', billing_tier: 'pro' }];
    const subs: SubSummary[] = []; // no active subs
    expect(planReconciliation(users, subs, priceToTier)).toEqual([{ userId: 'u1', tier: 'free' }]);
  });

  it('keeps a past_due customer on their paid tier (grace)', () => {
    const users: ReconcileUser[] = [{ id: 'u1', stripe_customer_id: 'cus_1', billing_tier: 'pro' }];
    const subs: SubSummary[] = [{ customer: 'cus_1', status: 'past_due', priceId: 'price_pro' }];
    expect(planReconciliation(users, subs, priceToTier)).toEqual([]);
  });

  it('makes no change when DB already matches Stripe', () => {
    const users: ReconcileUser[] = [{ id: 'u1', stripe_customer_id: 'cus_1', billing_tier: 'business' }];
    const subs: SubSummary[] = [{ customer: 'cus_1', status: 'active', priceId: 'price_biz' }];
    expect(planReconciliation(users, subs, priceToTier)).toEqual([]);
  });

  it('picks the highest tier when a customer has multiple subs', () => {
    const users: ReconcileUser[] = [{ id: 'u1', stripe_customer_id: 'cus_1', billing_tier: 'free' }];
    const subs: SubSummary[] = [
      { customer: 'cus_1', status: 'active', priceId: 'price_pro' },
      { customer: 'cus_1', status: 'active', priceId: 'price_biz' },
    ];
    expect(planReconciliation(users, subs, priceToTier)).toEqual([{ userId: 'u1', tier: 'business' }]);
  });

  it('ignores users with no stripe customer', () => {
    const users: ReconcileUser[] = [{ id: 'u1', stripe_customer_id: null, billing_tier: 'free' }];
    expect(planReconciliation(users, [], priceToTier)).toEqual([]);
  });
});
