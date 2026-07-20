// SnapOG — Main Cloudflare Worker
// Routes: GET /og (image gen), GET / (landing), GET/POST /register, GET /dashboard

import { Hono } from 'hono';
import { generateOGImage, buildCacheKey } from './og/render';
import {
  landingPage,
  registerPage,
  keyCreatedPage,
  dashboardPage,
  errorPage,
} from './dashboard/pages';
import type { ApiKey, Env, OGParams, Tier, User } from './types';
import { TIER_LIMITS, isPaidTier, priceIdToTier, tierToPriceId } from './types';
import {
  createCheckoutSession,
  createStripeCustomer,
  verifyStripeSignature,
} from './billing/stripe';

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

// Increment usage counter and record event
async function recordUsage(
  db: D1Database,
  key: ApiKey,
  template: string,
  cacheHit: boolean
): Promise<void> {
  const eventId = crypto.randomUUID();
  await db.batch([
    // Conditional increment so concurrent requests cannot push usage_count
    // past monthly_limit — the stored counter can never run away even though
    // the pre-generation check and this increment are separate steps.
    db
      .prepare(
        'UPDATE api_keys SET usage_count = usage_count + 1 WHERE id = ? AND usage_count < monthly_limit'
      )
      .bind(key.id),
    db
      .prepare(
        'INSERT INTO usage_events (id, api_key_id, template, cache_hit) VALUES (?, ?, ?, ?)'
      )
      .bind(eventId, key.id, template, cacheHit ? 1 : 0),
  ]);
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Landing page
app.get('/', c => {
  const host = new URL(c.req.url).host;
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

  // Check rate limit
  if (apiKey.usage_count >= apiKey.monthly_limit) {
    return c.json(
      {
        error: 'Monthly image limit reached',
        tier: apiKey.tier,
        limit: apiKey.monthly_limit,
        upgrade_url: '/register?tier=pro',
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
    // Cache hit — return stored PNG, still track usage (counts toward limit)
    await recordUsage(c.env.DB, apiKey, params.template ?? 'default', true);
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
    // Never return an HTML error body to a client that requested image/png
    // (a scraper or <img> tag). Respond JSON so the failure is unambiguous.
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

  // Record usage (also fire-and-forget after we have the image)
  c.executionCtx.waitUntil(
    recordUsage(c.env.DB, apiKey, params.template ?? 'default', false)
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
  return htmlResponse(registerPage(undefined, tier));
});

app.post('/register', async c => {
  let email: string, keyname: string, tier: string;
  try {
    const form = await c.req.formData();
    email = (form.get('email') as string ?? '').trim().toLowerCase();
    keyname = (form.get('keyname') as string ?? '').trim() || 'default';
    tier = (form.get('tier') as string ?? 'free').trim();
  } catch {
    return htmlResponse(registerPage('Invalid form data'), 400);
  }

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return htmlResponse(registerPage('Please enter a valid email address', tier), 400);
  }

  const validTiers: Tier[] = ['free', 'pro', 'business'];
  const safeTier: Tier = validTiers.includes(tier as Tier) ? (tier as Tier) : 'free';

  // Upsert user
  const userId = crypto.randomUUID();
  await c.env.DB
    .prepare(
      'INSERT INTO users (id, email) VALUES (?, ?) ON CONFLICT(email) DO NOTHING'
    )
    .bind(userId, email)
    .run();

  const user = await c.env.DB
    .prepare('SELECT id FROM users WHERE email = ?')
    .bind(email)
    .first<{ id: string }>();
  if (!user) {
    return htmlResponse(registerPage('Database error — please try again'), 500);
  }

  // Generate API key
  const rawKey = generateRawKey();
  const keyHash = await sha256(rawKey);
  const keyPrefix = rawKey.slice(0, 12);
  const keyId = crypto.randomUUID();
  const resetAt = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const monthlyLimit = TIER_LIMITS[safeTier];

  await c.env.DB
    .prepare(
      `INSERT INTO api_keys
         (id, user_id, name, key_prefix, key_hash, tier, monthly_limit, usage_reset_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(keyId, user.id, keyname, keyPrefix, keyHash, safeTier, monthlyLimit, resetAt)
    .run();

  return htmlResponse(keyCreatedPage(rawKey, email, safeTier));
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
          const active = status === 'active' || status === 'trialing';
          const subId = typeof obj.id === 'string' ? obj.id : null;
          // Grant the tier only while the subscription is in good standing.
          await applyTierToUser(c.env.DB, user.id, active && tier ? tier : 'free', status, subId);
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

// ── Health / ops ──────────────────────────────────────────────────────────────
app.get('/health', c => c.json({ ok: true, ts: new Date().toISOString() }));

// 404 fallback
app.notFound(_c => htmlResponse(errorPage(404, 'Page not found'), 404));
app.onError((err, _c) => {
  console.error('Unhandled error:', err);
  return htmlResponse(errorPage(500, 'Internal server error'), 500);
});

export default app;
