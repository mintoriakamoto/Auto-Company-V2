// SnapOG — shared types

export type Tier = 'free' | 'pro' | 'business';

export const TIER_LIMITS: Record<Tier, number> = {
  free: 100,
  pro: 10_000,
  business: 100_000,
};

// Monthly price in USD, for display + sanity only (source of truth is the
// Stripe Price object referenced by STRIPE_PRICE_*).
export const TIER_PRICE_USD: Record<Tier, number> = {
  free: 0,
  pro: 19,
  business: 49,
};

export const PAID_TIERS: readonly Tier[] = ['pro', 'business'] as const;

export function isPaidTier(tier: string): tier is 'pro' | 'business' {
  return tier === 'pro' || tier === 'business';
}

export interface ApiKey {
  id: string;
  user_id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  tier: Tier;
  monthly_limit: number;
  usage_count: number;
  usage_reset_at: string;
  created_at: string;
}

export interface OGParams {
  title: string;
  description?: string;
  theme?: 'dark' | 'light';
  template?: 'default' | 'blog' | 'article';
  author?: string;
  domain?: string;
  tag?: string;
}

export interface User {
  id: string;
  email: string;
  created_at: string;
  stripe_customer_id?: string | null;
  stripe_subscription_id?: string | null;
  billing_tier?: Tier;
  billing_status?: string;
}

export interface Env {
  DB: D1Database;
  OG_CACHE: R2Bucket;
  ENVIRONMENT: string;
  AUTH_SECRET?: string;

  // Billing (set via `wrangler secret put` / dashboard vars — never committed).
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_PRO?: string;
  STRIPE_PRICE_BUSINESS?: string;
  // Public base URL, e.g. https://snapog.dev — used for checkout redirects.
  APP_URL?: string;
}

// Maps a Stripe Price id back to the tier it grants. Built at request time
// from the configured env so there is a single source of truth.
export function priceIdToTier(
  env: Env,
  priceId: string | undefined | null
): Tier | null {
  if (!priceId) return null;
  if (priceId === env.STRIPE_PRICE_PRO) return 'pro';
  if (priceId === env.STRIPE_PRICE_BUSINESS) return 'business';
  return null;
}

export function tierToPriceId(env: Env, tier: Tier): string | null {
  if (tier === 'pro') return env.STRIPE_PRICE_PRO ?? null;
  if (tier === 'business') return env.STRIPE_PRICE_BUSINESS ?? null;
  return null;
}
