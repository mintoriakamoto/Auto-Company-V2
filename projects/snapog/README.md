# SnapOG

Generate stunning Open Graph images via API — hosted on Cloudflare Workers, cached globally on R2, sub-100ms on cache hit.

## Quick Start

```bash
# Get a free API key at https://snapog.dev/register, then:
curl "https://snapog.dev/og?title=My+Blog+Post&domain=myblog.com&key=sk_YOUR_KEY" \
  --output og.png && open og.png
```

## API

```
GET /og
  ?title=Your Page Title     # required, max 120 chars
  &key=sk_your_key           # required
  &description=Subtitle      # optional, max 200 chars
  &domain=yourdomain.com     # optional
  &author=Jane Doe           # optional
  &tag=Tutorial              # optional, shown as pill badge
  &template=default          # default | blog | article
  &theme=dark                # dark | light
```

Returns `image/png`, 1200×630.

Headers:
- `X-Cache: HIT|MISS` — whether served from R2 cache
- `X-SnapOG-Tier: free|pro|business`

## HTML Integration

```html
<meta property="og:image"
      content="https://snapog.dev/og?title=YOUR_TITLE&key=YOUR_KEY" />
<meta property="og:image:width"  content="1200" />
<meta property="og:image:height" content="630" />
<meta name="twitter:card"   content="summary_large_image" />
<meta name="twitter:image"  content="https://snapog.dev/og?title=YOUR_TITLE&key=YOUR_KEY" />
```

## Pricing

| Tier | Price | Images/month |
|------|-------|-------------|
| Free | $0 | 100 |
| Pro | $19/mo | 10,000 |
| Business | $49/mo | 100,000 |

Free tier images include "snapog.dev" watermark.

## Local Development

### Prerequisites
- Node.js 18+, npm
- Wrangler (`npm install -g wrangler`)
- A Cloudflare account with Workers access

### Setup

```bash
cd projects/snapog
npm install

# 1. Create D1 database
wrangler d1 create snapog-db
# Copy the returned database_id into wrangler.toml [d1_databases]

# 2. Apply migrations locally
npm run db:local

# 3. Create R2 bucket (local R2 is simulated)
# No setup needed for local dev — wrangler simulates R2

# 4. Start dev server
npm run dev
```

Open http://127.0.0.1:8787

### Test

```bash
# Register a key via browser at http://127.0.0.1:8787/register
# Then test with:
API_KEY=sk_your_key bash sample/smoke-test.sh

# Or direct curl:
curl "http://127.0.0.1:8787/og?title=Hello+World&key=sk_your_key" --output og.png
```

### Typecheck

```bash
npm run typecheck
```

## Deployment

```bash
# 1. Create remote D1 database
wrangler d1 create snapog-db
# Update wrangler.toml with the database_id

# 2. Apply migrations to remote
npm run db:remote

# 3. Create R2 bucket
wrangler r2 bucket create snapog-og-cache

# 4. Deploy
wrangler deploy
```

## Billing (Stripe)

SnapOG monetizes via Stripe subscriptions. The free tier works with no billing
config; paid upgrades require Stripe to be wired up.

**One-time setup:**

1. In the Stripe dashboard, create two recurring Products/Prices (Pro $19/mo,
   Business $49/mo) and copy their `price_...` ids into `wrangler.toml`
   (`STRIPE_PRICE_PRO`, `STRIPE_PRICE_BUSINESS`) and `APP_URL` for the env.
2. Set the secrets (never committed):
   ```bash
   wrangler secret put STRIPE_SECRET_KEY       # sk_live_... or sk_test_...
   wrangler secret put STRIPE_WEBHOOK_SECRET    # whsec_... from the webhook
   ```
3. Add a Stripe webhook endpoint pointing at `https://<your-domain>/billing/webhook`
   subscribed to `customer.subscription.created`, `customer.subscription.updated`,
   and `customer.subscription.deleted`.

**Flow:** a signed-in user clicks *Upgrade* on `/dashboard` → `POST /billing/checkout`
creates a Stripe Checkout Session and redirects there → on payment, Stripe calls
`/billing/webhook`, whose handler verifies the signature (HMAC-SHA256 via Web
Crypto), is idempotent per event id, and updates the account's tier and monthly
limit. Cancellation downgrades to free.

The webhook is the only trusted source of subscription state — the client never
sets its own tier. Signature verification is unit-tested (`test/stripe.test.ts`).

## Growth metrics + attribution

- **Attribution:** append `?ref=<channel>` (or `utm_source=`) to any link you
  share; it is captured at `/register` and stored on the user, so revenue can be
  broken down by acquisition channel.
- **Metrics API:** `GET /admin/metrics` returns JSON — `signups`,
  `paying_customers`, `mrr_usd`, `conversion_rate`, and a per-source breakdown.
  Guard it with a token: `wrangler secret put ADMIN_METRICS_TOKEN`, then call
  with `Authorization: Bearer <token>` (or `?token=`). This is the ground-truth
  feed the autonomous loop reads each cycle (`METRICS_URL` → injected as
  "Live Metrics"). Aggregation is unit-tested in `test/metrics.test.ts`.

## Security

- **Output escaping.** All request- and DB-derived values reflected into HTML
  pages pass through `escapeHtml()` (`src/dashboard/pages.ts`); the `tier` query
  param is also validated against the tier whitelist before rendering.
- **Referer suppression.** HTML responses send `Referrer-Policy: no-referrer` so
  API keys carried in `?key=` query strings are not leaked via the `Referer`
  header to third parties.
- **Known limitation — keys in public URLs (by design).** The current auth model
  puts the raw key in the request URL (`/og?key=...`), and the documented
  `og:image` integration embeds it in public page source, so a key used this way
  is discoverable and its monthly quota can be exhausted by others. Mitigations
  on the roadmap: HMAC-signed request URLs (the reserved `AUTH_SECRET` secret is
  intended for this), domain-scoped tokens, and/or a `Referer`/origin allowlist
  enforced per key. Until then, treat keys as low-trust, rate-limited tokens,
  not secrets.

## Tech Stack

- [Cloudflare Workers](https://workers.cloudflare.com/) — edge compute
- [Hono](https://hono.dev/) — HTTP framework
- [workers-og](https://github.com/kvnang/workers-og) — OG image generation (Satori-based)
- [Cloudflare D1](https://developers.cloudflare.com/d1/) — SQLite for usage tracking
- [Cloudflare R2](https://developers.cloudflare.com/r2/) — image cache storage
