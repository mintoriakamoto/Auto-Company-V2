// SnapOG — Stripe billing helpers (Workers-native, no SDK)
//
// Uses the Stripe REST API over fetch and Web Crypto for webhook signature
// verification, so it runs on Cloudflare Workers without the Node SDK.

const STRIPE_API = 'https://api.stripe.com/v1';
const DEFAULT_TOLERANCE_SEC = 300;

// ─── Form encoding ──────────────────────────────────────────────────────────
// Stripe's API takes application/x-www-form-urlencoded with bracketed nested
// keys, e.g. line_items[0][price]=price_123.
export function encodeForm(
  obj: Record<string, unknown>,
  prefix = ''
): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    const encodedKey = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === 'object') {
      const nested = encodeForm(value as Record<string, unknown>, encodedKey);
      if (nested) parts.push(nested);
    } else {
      parts.push(`${encodeURIComponent(encodedKey)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts.join('&');
}

// ─── Webhook signature verification ─────────────────────────────────────────

export interface ParsedSignature {
  timestamp: number;
  signatures: string[];
}

export function parseSignatureHeader(header: string | null): ParsedSignature | null {
  if (!header) return null;
  let timestamp = NaN;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (key === 't') timestamp = Number(val);
    else if (key === 'v1') signatures.push(val);
  }
  if (!Number.isFinite(timestamp) || signatures.length === 0) return null;
  return { timestamp, signatures };
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function computeSignature(secret: string, payload: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return toHex(sig);
}

// Constant-time comparison of two equal-length hex strings.
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export interface VerifyOptions {
  payload: string;
  header: string | null;
  secret: string;
  toleranceSec?: number;
  nowMs?: number;
}

// Verify a Stripe webhook signature (scheme: HMAC-SHA256 over `${t}.${payload}`,
// compared to any v1 value, within a timestamp tolerance). Returns true only
// for an authentic, fresh event.
export async function verifyStripeSignature(opts: VerifyOptions): Promise<boolean> {
  const parsed = parseSignatureHeader(opts.header);
  if (!parsed || !opts.secret) return false;

  const tolerance = opts.toleranceSec ?? DEFAULT_TOLERANCE_SEC;
  const nowSec = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  if (Math.abs(nowSec - parsed.timestamp) > tolerance) return false;

  const expected = await computeSignature(opts.secret, `${parsed.timestamp}.${opts.payload}`);
  return parsed.signatures.some(sig => timingSafeEqual(sig, expected));
}

// ─── Stripe REST calls ──────────────────────────────────────────────────────

async function stripeRequest(
  secretKey: string,
  path: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: encodeForm(body),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    const err = (data.error as { message?: string } | undefined)?.message ?? res.statusText;
    throw new Error(`Stripe API error (${res.status}): ${err}`);
  }
  return data;
}

async function stripeGet(
  secretKey: string,
  path: string
): Promise<Record<string, unknown>> {
  const res = await fetch(`${STRIPE_API}${path}`, {
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    const err = (data.error as { message?: string } | undefined)?.message ?? res.statusText;
    throw new Error(`Stripe API error (${res.status}): ${err}`);
  }
  return data;
}

// ─── Authoritative revenue (read directly from Stripe) ──────────────────────

interface StripeSubscription {
  status?: string;
  items?: {
    data?: Array<{
      price?: { id?: string; unit_amount?: number; recurring?: { interval?: string } };
    }>;
  };
}

// Monthly recurring revenue in whole USD. MRR counts only genuinely-collecting
// subscriptions: `active` and `past_due` (subscribed, retrying), NOT `trialing`
// (which bills $0 today). Trials and at-risk are reported separately so the
// autonomous loop isn't misled by inflated revenue. Yearly prices normalized
// to monthly. Pure — unit-testable without hitting Stripe.
export function computeStripeMrr(subs: StripeSubscription[]): {
  mrr_usd: number;
  active: number;
  trialing: number;
  at_risk: number;
} {
  const revenueStatuses = new Set(['active', 'past_due']);
  let cents = 0;
  let active = 0;
  let trialing = 0;
  let atRisk = 0;
  for (const sub of subs) {
    if (sub.status === 'trialing') trialing += 1;
    if (sub.status === 'past_due') atRisk += 1;
    if (!sub.status || !revenueStatuses.has(sub.status)) continue;
    if (sub.status === 'active') active += 1;
    for (const item of sub.items?.data ?? []) {
      const amount = item.price?.unit_amount ?? 0;
      const interval = item.price?.recurring?.interval ?? 'month';
      cents += interval === 'year' ? Math.round(amount / 12) : amount;
    }
  }
  return { mrr_usd: Math.round(cents / 100), active, trialing, at_risk: atRisk };
}

// A subscription with the fields reconciliation needs.
export interface SubscriptionSummary {
  id: string;
  customer: string;
  status: string;
  priceId: string | undefined;
}

// Fetch all subscriptions (paginated), returning the raw list (for MRR), a
// normalized summary (for reconciliation), and `complete` — true only when
// every page was consumed (Stripe reported has_more=false). `complete=false`
// means the result may be missing subscriptions (page cap hit or a partial
// page), and reconciliation MUST NOT downgrade based on it.
export async function fetchSubscriptions(secretKey: string): Promise<{
  raw: StripeSubscription[];
  summaries: SubscriptionSummary[];
  complete: boolean;
}> {
  const raw: StripeSubscription[] = [];
  const summaries: SubscriptionSummary[] = [];
  let startingAfter: string | undefined;
  let complete = false;
  const MAX_PAGES = 20;
  for (let page = 0; page < MAX_PAGES; page++) {
    const qs = new URLSearchParams({ status: 'all', limit: '100' });
    if (startingAfter) qs.set('starting_after', startingAfter);
    const data = await stripeGet(secretKey, `/subscriptions?${qs.toString()}`);
    if (!Array.isArray(data.data)) {
      // Malformed/partial response — treat as incomplete, do not trust.
      return { raw, summaries, complete: false };
    }
    const batch = data.data as Array<StripeSubscription & { id?: string; customer?: string }>;
    for (const sub of batch) {
      raw.push(sub);
      summaries.push({
        id: typeof sub.id === 'string' ? sub.id : '',
        customer: typeof sub.customer === 'string' ? sub.customer : '',
        status: sub.status ?? '',
        priceId: sub.items?.data?.[0]?.price?.id,
      });
    }
    if (!data.has_more || batch.length === 0) {
      complete = true;
      break;
    }
    startingAfter = batch[batch.length - 1]?.id;
    if (!startingAfter) {
      // Can't paginate further safely — incomplete.
      break;
    }
  }
  return { raw, summaries, complete };
}

// Fetch all subscriptions (paginated) and compute authoritative MRR.
export async function fetchStripeMrr(
  secretKey: string
): Promise<{ mrr_usd: number; active: number; trialing: number; at_risk: number }> {
  const { raw } = await fetchSubscriptions(secretKey);
  return computeStripeMrr(raw);
}

// Current Stripe balance (money on the way to your bank), in whole USD.
export function parseBalance(balance: Record<string, unknown>): {
  available_usd: number;
  pending_usd: number;
} {
  const sumUsd = (entries: unknown): number => {
    if (!Array.isArray(entries)) return 0;
    let cents = 0;
    for (const e of entries) {
      const rec = e as { amount?: number; currency?: string };
      if (rec.currency === 'usd') cents += rec.amount ?? 0;
    }
    return Math.round(cents / 100);
  };
  return {
    available_usd: sumUsd(balance.available),
    pending_usd: sumUsd(balance.pending),
  };
}

export async function fetchStripeBalance(
  secretKey: string
): Promise<{ available_usd: number; pending_usd: number }> {
  const balance = await stripeGet(secretKey, '/balance');
  return parseBalance(balance);
}

export async function createStripeCustomer(
  secretKey: string,
  email: string,
  userId: string
): Promise<string> {
  const customer = await stripeRequest(secretKey, '/customers', {
    email,
    metadata: { user_id: userId },
  });
  return customer.id as string;
}

export interface CheckoutParams {
  secretKey: string;
  priceId: string;
  customerId: string;
  clientReferenceId: string; // our user id
  successUrl: string;
  cancelUrl: string;
}

// Create a subscription Checkout Session and return its hosted URL.
export async function createCheckoutSession(params: CheckoutParams): Promise<string> {
  const session = await stripeRequest(params.secretKey, '/checkout/sessions', {
    mode: 'subscription',
    customer: params.customerId,
    client_reference_id: params.clientReferenceId,
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    line_items: { 0: { price: params.priceId, quantity: 1 } },
  });
  const url = session.url;
  if (typeof url !== 'string') {
    throw new Error('Stripe did not return a checkout URL');
  }
  return url;
}
