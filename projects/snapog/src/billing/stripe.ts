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
