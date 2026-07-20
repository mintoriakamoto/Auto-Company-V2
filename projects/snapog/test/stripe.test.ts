import { describe, it, expect } from 'vitest';
import {
  encodeForm,
  parseSignatureHeader,
  computeSignature,
  timingSafeEqual,
  verifyStripeSignature,
  computeStripeMrr,
  parseBalance,
} from '../src/billing/stripe';
import { priceIdToTier, tierToPriceId } from '../src/types';
import type { Env } from '../src/types';

const SECRET = 'whsec_test_secret';

// Build a valid Stripe-Signature header for a payload at a given time.
async function signedHeader(payload: string, timestamp: number): Promise<string> {
  const sig = await computeSignature(SECRET, `${timestamp}.${payload}`);
  return `t=${timestamp},v1=${sig}`;
}

describe('encodeForm', () => {
  it('encodes nested bracketed keys the way Stripe expects', () => {
    const out = encodeForm({
      mode: 'subscription',
      line_items: { 0: { price: 'price_123', quantity: 1 } },
    });
    expect(out).toContain('mode=subscription');
    expect(out).toContain('line_items%5B0%5D%5Bprice%5D=price_123');
    expect(out).toContain('line_items%5B0%5D%5Bquantity%5D=1');
  });

  it('skips null/undefined values', () => {
    expect(encodeForm({ a: 'x', b: null, c: undefined })).toBe('a=x');
  });
});

describe('parseSignatureHeader', () => {
  it('parses timestamp and v1 signatures', () => {
    const parsed = parseSignatureHeader('t=123,v1=abc,v1=def');
    expect(parsed).toEqual({ timestamp: 123, signatures: ['abc', 'def'] });
  });

  it('rejects headers with no timestamp or signature', () => {
    expect(parseSignatureHeader(null)).toBeNull();
    expect(parseSignatureHeader('v1=abc')).toBeNull();
    expect(parseSignatureHeader('t=123')).toBeNull();
  });
});

describe('timingSafeEqual', () => {
  it('is true only for identical equal-length strings', () => {
    expect(timingSafeEqual('abcdef', 'abcdef')).toBe(true);
    expect(timingSafeEqual('abcdef', 'abcdeg')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('verifyStripeSignature', () => {
  const payload = JSON.stringify({ id: 'evt_1', type: 'customer.subscription.updated' });
  const now = 1_700_000_000_000; // fixed ms

  it('accepts a correctly signed, fresh event', async () => {
    const header = await signedHeader(payload, Math.floor(now / 1000));
    expect(await verifyStripeSignature({ payload, header, secret: SECRET, nowMs: now })).toBe(true);
  });

  it('rejects a tampered payload', async () => {
    const header = await signedHeader(payload, Math.floor(now / 1000));
    expect(
      await verifyStripeSignature({ payload: payload + 'x', header, secret: SECRET, nowMs: now })
    ).toBe(false);
  });

  it('rejects a wrong secret', async () => {
    const header = await signedHeader(payload, Math.floor(now / 1000));
    expect(
      await verifyStripeSignature({ payload, header, secret: 'whsec_wrong', nowMs: now })
    ).toBe(false);
  });

  it('rejects an expired timestamp outside tolerance', async () => {
    const oldTs = Math.floor(now / 1000) - 10_000;
    const header = await signedHeader(payload, oldTs);
    expect(await verifyStripeSignature({ payload, header, secret: SECRET, nowMs: now })).toBe(false);
  });

  it('rejects a missing/garbage header', async () => {
    expect(await verifyStripeSignature({ payload, header: null, secret: SECRET, nowMs: now })).toBe(false);
    expect(await verifyStripeSignature({ payload, header: 'garbage', secret: SECRET, nowMs: now })).toBe(false);
  });
});

describe('price <-> tier mapping', () => {
  const env = {
    STRIPE_PRICE_PRO: 'price_pro',
    STRIPE_PRICE_BUSINESS: 'price_biz',
  } as Env;

  it('maps price ids to tiers', () => {
    expect(priceIdToTier(env, 'price_pro')).toBe('pro');
    expect(priceIdToTier(env, 'price_biz')).toBe('business');
    expect(priceIdToTier(env, 'price_unknown')).toBeNull();
    expect(priceIdToTier(env, undefined)).toBeNull();
  });

  it('maps tiers back to price ids', () => {
    expect(tierToPriceId(env, 'pro')).toBe('price_pro');
    expect(tierToPriceId(env, 'business')).toBe('price_biz');
    expect(tierToPriceId(env, 'free')).toBeNull();
  });
});

describe('computeStripeMrr', () => {
  it('sums monthly amounts for counted statuses only', () => {
    const subs = [
      { status: 'active', items: { data: [{ price: { unit_amount: 1900, recurring: { interval: 'month' } } }] } },
      { status: 'past_due', items: { data: [{ price: { unit_amount: 4900, recurring: { interval: 'month' } } }] } },
      { status: 'canceled', items: { data: [{ price: { unit_amount: 1900, recurring: { interval: 'month' } } }] } }, // ignored
    ];
    const r = computeStripeMrr(subs);
    expect(r.active).toBe(2);
    expect(r.mrr_usd).toBe(68); // 19 + 49
  });

  it('normalizes yearly prices to monthly', () => {
    const subs = [
      { status: 'active', items: { data: [{ price: { unit_amount: 12000, recurring: { interval: 'year' } } }] } },
    ];
    expect(computeStripeMrr(subs).mrr_usd).toBe(10); // 120/yr -> 10/mo
  });

  it('is zero for no counted subscriptions', () => {
    expect(computeStripeMrr([]).mrr_usd).toBe(0);
  });
});

describe('parseBalance', () => {
  it('sums usd available and pending, ignoring other currencies', () => {
    const b = {
      available: [{ amount: 5000, currency: 'usd' }, { amount: 9999, currency: 'eur' }],
      pending: [{ amount: 2500, currency: 'usd' }],
    };
    expect(parseBalance(b)).toEqual({ available_usd: 50, pending_usd: 25 });
  });

  it('handles missing fields', () => {
    expect(parseBalance({})).toEqual({ available_usd: 0, pending_usd: 0 });
  });
});
