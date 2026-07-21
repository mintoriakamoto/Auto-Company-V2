// SnapOG — Main Cloudflare Worker
// Routes: GET /og (image gen), GET / (landing), GET/POST /register, GET /dashboard

import { Hono } from 'hono';
import { generateOGImage, buildCacheKey } from './og/render';
import {
  landingPage,
  registerPage,
  keyCreatedPage,
  recoverPage,
  dashboardPage,
  errorPage,
  termsPage,
  privacyPage,
  refundPage,
  type LegalConfig,
} from './dashboard/pages';
import type { ApiKey, Env, OGParams, Tier, User } from './types';
import { TIER_LIMITS, isPaidTier, priceIdToTier, tierToPriceId } from './types';
import {
  createCheckoutSession,
  createStripeCustomer,
  verifyStripeSignature,
  timingSafeEqual,
  fetchStripeMrr,
  fetchStripeBalance,
  fetchSubscriptions,
} from './billing/stripe';
import { computeMetrics, normalizeSource, subscriptionGrant, type UserRow } from './metrics';
import { planReconciliation, type ReconcileUser } from './reconcile';
import { encryptSecret, decryptSecret } from './crypto';
import { sendEmail, apiKeyEmail, receiptEmail, activationNudgeEmail, emailConfigured } from './email';

const app = new Hono<{ Bindings: Env }>();

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text)
  );
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function generateRawKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return 'sk_' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // API keys travel in query strings (?key=...); suppress the Referer so
      // they are not leaked to third parties when users click outbound links.
      'Referrer-Policy': 'no-referrer',
    },
  });
}

// Validate an API key from request and return the DB row, or null
async function resolveApiKey(
  db: D1Database,
  rawKey: string | null
): Promise<ApiKey | null> {
  if (!rawKey) return null;
  const hash = await sha256(rawKey);
  const row = await db
    .prepare('SELECT * FROM api_keys WHERE key_hash = ?')
    .bind(hash)
    .first<ApiKey>();
  return row ?? null;
}

// Reset monthly usage if billing month rolled over
async function maybeResetUsage(db: D1Database, key: ApiKey): Promise<ApiKey> {
  const resetAt = new Date(key.usage_reset_at);
  const now = new Date();
  const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  if (resetAt < thisMonth) {
    const newResetAt = thisMonth.toISOString();
    await db
      .prepare(
        'UPDATE api_keys SET usage_count = 0, usage_reset_at = ? WHERE id = ?'
      )
      .bind(newResetAt, key.id)
      .run();
    return { ...key, usage_count: 0, usage_reset_at: newResetAt };
  }
  return key;
}

// Atomically reserve one image against the monthly quota BEFORE doing any
// work. The conditional UPDATE both enforces the limit and counts usage in a
// single race-free step (no read-then-check window, no fire-and-forget
// undercount). Returns true if a slot was reserved, false if at the limit.
async function reserveUsage(db: D1Database, key: ApiKey): Promise<boolean> {
  const res = await db
    .prepare(
      'UPDATE api_keys SET usage_count = usage_count + 1 WHERE id = ? AND usage_count < monthly_limit'
    )
    .bind(key.id)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

// Give a reserved slot back when the work fails, so a generation error does
// not silently burn a customer's quota.
async function refundUsage(db: D1Database, key: ApiKey): Promise<void> {
  await db
    .prepare('UPDATE api_keys SET usage_count = usage_count - 1 WHERE id = ? AND usage_count > 0')
    .bind(key.id)
    .run();
}

// Analytics only (billing already accounted for by reserveUsage).
async function recordUsageEvent(
  db: D1Database,
  key: ApiKey,
  template: string,
  cacheHit: boolean
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO usage_events (id, api_key_id, template, cache_hit) VALUES (?, ?, ?, ?)'
    )
    .bind(crypto.randomUUID(), key.id, template, cacheHit ? 1 : 0)
    .run();
}

type FunnelEvent =
  | 'landing_viewed'
  | 'register_viewed'
  | 'limit_reached'
  | 'checkout_started'
  | 'converted';

// Record a conversion-funnel event (fire-and-forget; never blocks the response).
async function recordFunnelEvent(
  db: D1Database,
  event: FunnelEvent,
  apiKeyId: string | null,
  source: string | null
): Promise<void> {
  await db
    .prepare('INSERT INTO funnel_events (id, event, api_key_id, source) VALUES (?, ?, ?, ?)')
    .bind(crypto.randomUUID(), event, apiKeyId, source)
    .run();
}

// Cheap bot filter so top-of-funnel view counts aren't dominated by crawlers.
function isLikelyBot(userAgent: string | undefined): boolean {
  if (!userAgent) return true;
  return /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|headless|curl|wget|python-requests|monitor|preview/i.test(
    userAgent
  );
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Landing page
app.get('/', c => {
  const host = new URL(c.req.url).host;
  if (!isLikelyBot(c.req.header('user-agent'))) {
    const source = normalizeSource(c.req.query('ref') ?? c.req.query('utm_source'));
    c.executionCtx.waitUntil(recordFunnelEvent(c.env.DB, 'landing_viewed', null, source));
  }
  return htmlResponse(landingPage(host));
});

// ── OG image generation ────────────────────────────────────────────────────────
app.get('/og', async c => {
  const q = c.req.query();
  const rawKey = q['key'] ?? null;

  // Validate required param
  const title = (q['title'] ?? '').trim().slice(0, 120);
  if (!title) {
    return c.json({ error: 'title parameter is required' }, 400);
  }

  // Resolve API key (required)
  if (!rawKey) {
    return c.json({ error: 'key parameter is required. Get a free key at /register' }, 401);
  }
  let apiKey = await resolveApiKey(c.env.DB, rawKey);
  if (!apiKey) {
    return c.json({ error: 'Invalid API key' }, 401);
  }

  // Reset usage if month rolled
  apiKey = await maybeResetUsage(c.env.DB, apiKey);

  // Atomically reserve a slot BEFORE any work. This both enforces the limit
  // and counts the usage race-free. Hitting the limit is the highest-intent
  // upgrade moment, so record it and point the caller at their dashboard.
  const reserved = await reserveUsage(c.env.DB, apiKey);
  if (!reserved) {
    c.executionCtx.waitUntil(recordFunnelEvent(c.env.DB, 'limit_reached', apiKey.id, apiKey.tier));
    const base = (c.env.APP_URL ?? new URL(c.req.url).origin).replace(/\/$/, '');
    return c.json(
      {
        error: 'Monthly image limit reached',
        tier: apiKey.tier,
        limit: apiKey.monthly_limit,
        upgrade_url: `${base}/dashboard?key=${encodeURIComponent(rawKey)}&ref=limit`,
      },
      429
    );
  }

  const params: OGParams = {
    title,
    description: (q['description'] ?? '').trim().slice(0, 200) || undefined,
    domain: (q['domain'] ?? '').trim().slice(0, 100) || undefined,
    author: (q['author'] ?? '').trim().slice(0, 80) || undefined,
    tag: (q['tag'] ?? '').trim().slice(0, 40) || undefined,
    theme: (q['theme'] === 'light' ? 'light' : 'dark') as 'dark' | 'light',
    template: (['blog', 'article'].includes(q['template'] ?? '')
      ? q['template']
      : 'default') as OGParams['template'],
  };

  const watermark = apiKey.tier === 'free';
  const cacheKey = await buildCacheKey(params, watermark);
  const r2Key = `og/${cacheKey}.png`;

  // ── R2 cache lookup ──
  const cached = await c.env.OG_CACHE.get(r2Key);
  if (cached) {
    // Cache hit — slot already reserved above; just log the analytics event.
    c.executionCtx.waitUntil(recordUsageEvent(c.env.DB, apiKey, params.template ?? 'default', true));
    const imageData = await cached.arrayBuffer();
    return new Response(imageData, {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=86400, s-maxage=604800',
        'X-Cache': 'HIT',
        'X-SnapOG-Tier': apiKey.tier,
      },
    });
  }

  // ── Generate image ──
  let imageBuffer: ArrayBuffer;
  try {
    const imageResponse = await generateOGImage(params, watermark);
    imageBuffer = await imageResponse.arrayBuffer();
  } catch (err) {
    // Generation failed — refund the reserved slot so the customer is not
    // charged a quota unit for a broken image, then return JSON (never HTML
    // to an image client).
    await refundUsage(c.env.DB, apiKey);
    console.error('OG image generation failed:', err);
    return c.json({ error: 'Failed to generate image' }, 500);
  }

  // Store in R2 (fire-and-forget, don't block response)
  c.executionCtx.waitUntil(
    c.env.OG_CACHE.put(r2Key, imageBuffer.slice(0), {
      httpMetadata: { contentType: 'image/png' },
      customMetadata: { tier: apiKey.tier, template: params.template ?? 'default' },
    })
  );

  // Log the analytics event (usage count already reserved).
  c.executionCtx.waitUntil(
    recordUsageEvent(c.env.DB, apiKey, params.template ?? 'default', false)
  );

  return new Response(imageBuffer, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=86400, s-maxage=604800',
      'X-Cache': 'MISS',
      'X-SnapOG-Tier': apiKey.tier,
    },
  });
});

// ── Registration ──────────────────────────────────────────────────────────────
app.get('/register', c => {
  // Validate tier against the whitelist before it is reflected into the page.
  const requested = c.req.query('tier');
  const validTiers: Tier[] = ['free', 'pro', 'business'];
  const tier = validTiers.includes(requested as Tier) ? requested : undefined;
  // Acquisition attribution: carry ?ref= (or utm_source) into the form so it
  // is stored on the user at signup. Gives the loop per-channel conversion.
  const source = normalizeSource(c.req.query('ref') ?? c.req.query('utm_source'));
  if (!isLikelyBot(c.req.header('user-agent'))) {
    c.executionCtx.waitUntil(recordFunnelEvent(c.env.DB, 'register_viewed', null, source));
  }
  return htmlResponse(registerPage(undefined, tier, source));
});

app.post('/register', async c => {
  let email: string, keyname: string, tier: string, source: string;
  try {
    const form = await c.req.formData();
    email = (form.get('email') as string ?? '').trim().toLowerCase();
    keyname = (form.get('keyname') as string ?? '').trim() || 'default';
    tier = (form.get('tier') as string ?? 'free').trim();
    source = normalizeSource(form.get('source') as string ?? '');
  } catch {
    return htmlResponse(registerPage('Invalid form data'), 400);
  }

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return htmlResponse(registerPage('Please enter a valid email address', tier), 400);
  }

  // A paid tier requested at signup is only an *intent* to upgrade — it never
  // grants a paid key. Paid tiers are granted solely by the Stripe webhook
  // after a successful payment. (Previously the requested tier was written
  // onto the key, handing out free Pro/Business keys.)
  const intendedTier = isPaidTier(tier) ? tier : undefined;

  // Upsert user (record acquisition source on first insert only).
  const userId = crypto.randomUUID();
  await c.env.DB
    .prepare(
      'INSERT INTO users (id, email, source) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING'
    )
    .bind(userId, email, source)
    .run();

  const user = await c.env.DB
    .prepare('SELECT id FROM users WHERE email = ?')
    .bind(email)
    .first<{ id: string }>();
  if (!user) {
    return htmlResponse(registerPage('Database error — please try again'), 500);
  }

  // Generate API key — ALWAYS on the free tier at signup.
  const rawKey = generateRawKey();
  const keyHash = await sha256(rawKey);
  const keyPrefix = rawKey.slice(0, 12);
  const keyId = crypto.randomUUID();
  const resetAt = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  // Store the key encrypted at rest (if configured) so it can be re-sent to
  // the owner's email on recovery.
  const keyEncrypted = c.env.AUTH_SECRET
    ? await encryptSecret(c.env.AUTH_SECRET, rawKey)
    : null;

  await c.env.DB
    .prepare(
      `INSERT INTO api_keys
         (id, user_id, name, key_prefix, key_hash, tier, monthly_limit, usage_reset_at, key_encrypted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(keyId, user.id, keyname, keyPrefix, keyHash, 'free', TIER_LIMITS.free, resetAt, keyEncrypted)
    .run();

  // Deliver the key by email too, so a closed tab doesn't lose access.
  const base = (c.env.APP_URL ?? new URL(c.req.url).origin).replace(/\/$/, '');
  c.executionCtx.waitUntil(sendEmail(c.env, apiKeyEmail(email, rawKey, base)));

  return htmlResponse(keyCreatedPage(rawKey, email, intendedTier));
});

// ── Key recovery ──────────────────────────────────────────────────────────────
// Re-send an existing key to its owner's email. Always returns a neutral
// message (never reveals whether an email is registered), and only works when
// AUTH_SECRET (to decrypt) and email are configured.
app.get('/recover', () => htmlResponse(recoverPage()));

app.post('/recover', async c => {
  let email = '';
  try {
    const form = await c.req.formData();
    email = (form.get('email') as string ?? '').trim().toLowerCase();
  } catch {
    return htmlResponse(recoverPage('Invalid form data'), 400);
  }

  const neutral = "If that email has a key, we've sent it. Check your inbox.";
  if (email && c.env.AUTH_SECRET) {
    const row = await c.env.DB
      .prepare(
        `SELECT k.key_encrypted AS enc FROM api_keys k
           JOIN users u ON u.id = k.user_id
          WHERE u.email = ? AND k.key_encrypted IS NOT NULL
          ORDER BY k.created_at DESC LIMIT 1`
      )
      .bind(email)
      .first<{ enc: string }>();
    if (row?.enc) {
      const rawKey = await decryptSecret(c.env.AUTH_SECRET, row.enc);
      if (rawKey) {
        const base = (c.env.APP_URL ?? new URL(c.req.url).origin).replace(/\/$/, '');
        c.executionCtx.waitUntil(sendEmail(c.env, apiKeyEmail(email, rawKey, base)));
      }
    }
  }
  return htmlResponse(recoverPage(undefined, neutral));
});

// ── Dashboard ─────────────────────────────────────────────────────────────────
app.get('/dashboard', async c => {
  const rawKey = c.req.query('key');
  if (!rawKey) {
    return htmlResponse(registerPage('Enter your API key or create a new one below'), 400);
  }

  const apiKey = await resolveApiKey(c.env.DB, rawKey);
  if (!apiKey) {
    return htmlResponse(errorPage(404, 'API key not found'), 404);
  }

  const refreshed = await maybeResetUsage(c.env.DB, apiKey);

  // Count recent events (last 24h)
  const yesterday = new Date(Date.now() - 86_400_000).toISOString();
  const recent = await c.env.DB
    .prepare(
      'SELECT COUNT(*) as cnt FROM usage_events WHERE api_key_id = ? AND generated_at > ?'
    )
    .bind(refreshed.id, yesterday)
    .first<{ cnt: number }>();

  return htmlResponse(dashboardPage(refreshed, recent?.cnt ?? 0, rawKey));
});

// ── Billing (Stripe) ────────────────────────────────────────────────────────

// Apply a tier to a user and all their API keys (single source of truth for
// what "being on a plan" means to the metering path).
async function applyTierToUser(
  db: D1Database,
  userId: string,
  tier: Tier,
  status: string,
  subscriptionId: string | null
): Promise<void> {
  await db.batch([
    db
      .prepare(
        'UPDATE users SET billing_tier = ?, billing_status = ?, stripe_subscription_id = ? WHERE id = ?'
      )
      .bind(tier, status, subscriptionId, userId),
    db
      .prepare('UPDATE api_keys SET tier = ?, monthly_limit = ? WHERE user_id = ?')
      .bind(tier, TIER_LIMITS[tier], userId),
  ]);
}

// Start a checkout: resolve the caller's key -> user, ensure a Stripe customer,
// and redirect to a hosted Checkout Session for the requested paid tier.
app.post('/billing/checkout', async c => {
  if (!c.env.STRIPE_SECRET_KEY) {
    return htmlResponse(errorPage(503, 'Billing is not configured'), 503);
  }

  let rawKey: string, tier: string;
  try {
    const form = await c.req.formData();
    rawKey = (form.get('key') as string ?? '').trim();
    tier = (form.get('tier') as string ?? '').trim();
  } catch {
    return htmlResponse(errorPage(400, 'Invalid form data'), 400);
  }

  if (!isPaidTier(tier)) {
    return htmlResponse(errorPage(400, 'Unknown plan'), 400);
  }
  const priceId = tierToPriceId(c.env, tier);
  if (!priceId) {
    return htmlResponse(errorPage(503, 'This plan is not available yet'), 503);
  }

  const apiKey = await resolveApiKey(c.env.DB, rawKey);
  if (!apiKey) {
    return htmlResponse(errorPage(404, 'API key not found'), 404);
  }
  const user = await c.env.DB
    .prepare('SELECT * FROM users WHERE id = ?')
    .bind(apiKey.user_id)
    .first<User>();
  if (!user) {
    return htmlResponse(errorPage(404, 'Account not found'), 404);
  }

  // Ensure a Stripe customer, persisting it so webhooks can map back to us.
  let customerId = user.stripe_customer_id ?? '';
  if (!customerId) {
    customerId = await createStripeCustomer(c.env.STRIPE_SECRET_KEY, user.email, user.id);
    await c.env.DB
      .prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?')
      .bind(customerId, user.id)
      .run();
  }

  const base = (c.env.APP_URL ?? new URL(c.req.url).origin).replace(/\/$/, '');
  const dashUrl = `${base}/dashboard?key=${encodeURIComponent(rawKey)}`;
  try {
    const checkoutUrl = await createCheckoutSession({
      secretKey: c.env.STRIPE_SECRET_KEY,
      priceId,
      customerId,
      clientReferenceId: user.id,
      successUrl: `${dashUrl}&upgraded=1`,
      cancelUrl: dashUrl,
    });
    c.executionCtx.waitUntil(
      recordFunnelEvent(c.env.DB, 'checkout_started', apiKey.id, user.source ?? null)
    );
    return c.redirect(checkoutUrl, 303);
  } catch (err) {
    console.error('Checkout creation failed:', err);
    return htmlResponse(errorPage(502, 'Could not start checkout — please try again'), 502);
  }
});

// Stripe webhook: the ONLY trusted source of subscription state. Verifies the
// signature, is idempotent per event id, and drives the account's tier.
app.post('/billing/webhook', async c => {
  const secret = c.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return c.json({ error: 'Billing not configured' }, 503);
  }

  const payload = await c.req.text();
  const ok = await verifyStripeSignature({
    payload,
    header: c.req.header('stripe-signature') ?? null,
    secret,
  });
  if (!ok) {
    return c.json({ error: 'Invalid signature' }, 400);
  }

  let event: {
    id?: string;
    type?: string;
    data?: { object?: Record<string, unknown> };
  };
  try {
    event = JSON.parse(payload);
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }
  if (!event.id || !event.type) {
    return c.json({ error: 'Malformed event' }, 400);
  }

  // Idempotency: record the event id first; a duplicate delivery no-ops.
  const insert = await c.env.DB
    .prepare('INSERT INTO billing_events (id, type) VALUES (?, ?) ON CONFLICT(id) DO NOTHING')
    .bind(event.id, event.type)
    .run();
  if (insert.meta.changes === 0) {
    return c.json({ received: true, duplicate: true });
  }

  const obj = event.data?.object ?? {};
  const findUserByCustomer = async (customerId: unknown): Promise<User | null> => {
    if (typeof customerId !== 'string' || !customerId) return null;
    return c.env.DB
      .prepare('SELECT * FROM users WHERE stripe_customer_id = ?')
      .bind(customerId)
      .first<User>();
  };

  try {
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const user = await findUserByCustomer(obj.customer);
        if (user) {
          const items = obj.items as { data?: Array<{ price?: { id?: string } }> } | undefined;
          const priceId = items?.data?.[0]?.price?.id;
          const tier = priceIdToTier(c.env, priceId);
          const status = typeof obj.status === 'string' ? obj.status : 'active';
          const subId = typeof obj.id === 'string' ? obj.id : null;
          const wasPaying = isPaidTier(user.billing_tier ?? 'free');
          // Keep the paid tier through the past_due grace window; only drop to
          // free once Stripe finally gives up (canceled/unpaid/etc).
          const grant = subscriptionGrant(status, tier);
          await applyTierToUser(c.env.DB, user.id, grant.tier, grant.status, subId);
          // Record the conversion the first time this account starts paying,
          // and send a receipt/welcome email.
          if (isPaidTier(grant.tier) && !wasPaying) {
            await recordFunnelEvent(c.env.DB, 'converted', null, user.source ?? null);
            const base = (c.env.APP_URL ?? new URL(c.req.url).origin).replace(/\/$/, '');
            c.executionCtx.waitUntil(sendEmail(c.env, receiptEmail(user.email, grant.tier, base)));
          }
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const user = await findUserByCustomer(obj.customer);
        if (user) {
          await applyTierToUser(c.env.DB, user.id, 'free', 'canceled', null);
        }
        break;
      }
      case 'invoice.payment_failed': {
        // Dunning: flag the account at-risk. Stripe retries on its own; we
        // keep the tier (grace) and let subscription.updated / .deleted make
        // the final call. Recording it surfaces churn risk in metrics.
        const user = await findUserByCustomer(obj.customer);
        if (user) {
          await c.env.DB
            .prepare('UPDATE users SET billing_status = ? WHERE id = ?')
            .bind('past_due', user.id)
            .run();
        }
        break;
      }
      default:
        // Other events are recorded (for audit) but need no action.
        break;
    }
  } catch (err) {
    console.error(`Webhook handler failed for ${event.type}:`, err);
    return c.json({ error: 'Handler error' }, 500);
  }

  return c.json({ received: true });
});

// Authoritative money numbers from Stripe, cached ~60s in the Cache API so the
// loop hitting /admin/metrics every cycle doesn't hammer Stripe (rate limits +
// latency). Best-effort: never throws; returns undefined/error on failure.
const STRIPE_CACHE_KEY = 'https://snapog.internal/cache/stripe-metrics';
async function getStripeSnapshot(env: Env): Promise<Record<string, unknown> | undefined> {
  if (!env.STRIPE_SECRET_KEY) return undefined;

  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  if (cache) {
    const hit = await cache.match(STRIPE_CACHE_KEY);
    if (hit) return (await hit.json()) as Record<string, unknown>;
  }

  let snapshot: Record<string, unknown>;
  try {
    const [mrr, balance] = await Promise.all([
      fetchStripeMrr(env.STRIPE_SECRET_KEY),
      fetchStripeBalance(env.STRIPE_SECRET_KEY),
    ]);
    snapshot = {
      mrr_usd: mrr.mrr_usd,
      active_subscriptions: mrr.active,
      balance_available_usd: balance.available_usd,
      balance_pending_usd: balance.pending_usd,
    };
  } catch (err) {
    console.error('Stripe revenue read failed:', err);
    return { error: 'stripe_read_failed' };
  }

  if (cache) {
    await cache.put(
      STRIPE_CACHE_KEY,
      new Response(JSON.stringify(snapshot), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=60' },
      })
    );
  }
  return snapshot;
}

// ── Growth metrics (ground truth for the autonomous loop) ────────────────────
// Token-protected JSON: signups, paying customers, MRR, conversion rate, and a
// per-source breakdown so the loop can double down on channels that convert.
app.get('/admin/metrics', async c => {
  const configured = c.env.ADMIN_METRICS_TOKEN;
  if (!configured) {
    return c.json({ error: 'Metrics not configured' }, 503);
  }
  const auth = c.req.header('authorization') ?? '';
  const presented = auth.startsWith('Bearer ') ? auth.slice(7) : c.req.query('token') ?? '';
  if (!presented || !timingSafeEqual(presented, configured)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const [rows, funnelRows] = await Promise.all([
    c.env.DB.prepare('SELECT source, billing_tier, billing_status FROM users').all<UserRow>(),
    c.env.DB.prepare('SELECT event FROM funnel_events').all<{ event: string }>(),
  ]);
  const metrics = computeMetrics(rows.results ?? [], funnelRows.results ?? []);

  const stripe = await getStripeSnapshot(c.env);
  return c.json({ ...metrics, stripe, generated_at: new Date().toISOString() });
});

// ── Legal / trust pages ──────────────────────────────────────────────────────
function legalConfig(env: Env): LegalConfig {
  return {
    entity: env.LEGAL_ENTITY || '[LEGAL ENTITY]',
    email: env.LEGAL_EMAIL || '[CONTACT EMAIL]',
    jurisdiction: env.LEGAL_JURISDICTION || '[JURISDICTION]',
    lastUpdated: '2026-07-20',
  };
}

app.get('/terms', c => htmlResponse(termsPage(legalConfig(c.env))));
app.get('/privacy', c => htmlResponse(privacyPage(legalConfig(c.env))));
app.get('/refunds', c => htmlResponse(refundPage(legalConfig(c.env))));

// ── Health / ops ──────────────────────────────────────────────────────────────
// Deep check: confirm the database is actually reachable, so an external
// uptime monitor (or the loop) gets a real signal, not just "process alive".
app.get('/health', async c => {
  try {
    await c.env.DB.prepare('SELECT 1').first();
    return c.json({ ok: true, db: 'ok', ts: new Date().toISOString() });
  } catch (err) {
    console.error('Health check DB failure:', err);
    return c.json({ ok: false, db: 'down', ts: new Date().toISOString() }, 503);
  }
});

// 404 fallback
app.notFound(_c => htmlResponse(errorPage(404, 'Page not found'), 404));
app.onError((err, _c) => {
  console.error('Unhandled error:', err);
  return htmlResponse(errorPage(500, 'Internal server error'), 500);
});

// ── Scheduled (cron) — money hygiene that webhooks can't guarantee ───────────
async function reconcileSubscriptions(env: Env): Promise<void> {
  if (!env.STRIPE_SECRET_KEY) return;
  const { summaries } = await fetchSubscriptions(env.STRIPE_SECRET_KEY);
  const users = await env.DB
    .prepare(
      'SELECT id, stripe_customer_id, billing_tier FROM users WHERE stripe_customer_id IS NOT NULL'
    )
    .all<ReconcileUser>();
  const changes = planReconciliation(
    users.results ?? [],
    summaries,
    priceId => priceIdToTier(env, priceId)
  );
  for (const change of changes) {
    await env.DB.batch([
      env.DB
        .prepare('UPDATE users SET billing_tier = ?, billing_status = ? WHERE id = ?')
        .bind(change.tier, 'reconciled', change.userId),
      env.DB
        .prepare('UPDATE api_keys SET tier = ?, monthly_limit = ? WHERE user_id = ?')
        .bind(change.tier, TIER_LIMITS[change.tier], change.userId),
    ]);
  }
  if (changes.length > 0) {
    console.log(`Reconciled ${changes.length} account(s) against Stripe.`);
  }
}

async function sendActivationNudges(env: Env): Promise<void> {
  if (!emailConfigured(env) || !env.AUTH_SECRET) return;
  const base = (env.APP_URL ?? '').replace(/\/$/, '');
  // Free users who signed up 2–3 days ago and have never generated an image.
  // The 1-day window means a daily cron nudges each such user roughly once
  // without needing a "nudged" flag.
  const rows = await env.DB
    .prepare(
      `SELECT u.email AS email, k.key_encrypted AS enc
         FROM users u JOIN api_keys k ON k.user_id = u.id
        WHERE COALESCE(u.billing_tier,'free') = 'free'
          AND k.key_encrypted IS NOT NULL
          AND u.created_at < datetime('now','-2 days')
          AND u.created_at >= datetime('now','-3 days')
          AND NOT EXISTS (SELECT 1 FROM usage_events e WHERE e.api_key_id = k.id)
        LIMIT 50`
    )
    .all<{ email: string; enc: string }>();
  for (const row of rows.results ?? []) {
    const rawKey = await decryptSecret(env.AUTH_SECRET, row.enc);
    if (rawKey) await sendEmail(env, activationNudgeEmail(row.email, rawKey, base));
  }
}

async function runScheduled(env: Env): Promise<void> {
  try {
    await reconcileSubscriptions(env);
  } catch (err) {
    console.error('Reconcile failed:', err);
  }
  try {
    await sendActivationNudges(env);
  } catch (err) {
    console.error('Activation nudges failed:', err);
  }
}

export default {
  fetch: app.fetch,
  scheduled: async (
    _event: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> => {
    ctx.waitUntil(runScheduled(env));
  },
} satisfies ExportedHandler<Env>;
