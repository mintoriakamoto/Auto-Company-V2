# Deploying SnapOG (clone → live → billable)

The `scripts/deploy.sh` helper automates the provisioning. This runbook is the
human checklist around it.

## Prerequisites

- A Cloudflare account with Workers, D1, and R2 enabled.
- A Stripe account (test mode is fine to start).
- `npm install` run in `projects/snapog`.
- `npx wrangler login` completed.

## 1. Provision + deploy

```bash
cd projects/snapog
./scripts/deploy.sh --check     # verify prerequisites, change nothing
./scripts/deploy.sh             # create D1 + R2, apply migrations, deploy
```

If this is the very first run, `deploy.sh` creates the D1 database and prints a
`database_id` — paste it into **every** `[[...d1_databases]]` block in
`wrangler.toml`, then run `./scripts/deploy.sh` again.

## 2. Secrets (never committed)

```bash
npx wrangler secret put STRIPE_SECRET_KEY       # sk_test_... to start
npx wrangler secret put STRIPE_WEBHOOK_SECRET    # from step 3
npx wrangler secret put ADMIN_METRICS_TOKEN      # long random string
npx wrangler secret put AUTH_SECRET              # long random string (also encrypts keys for recovery)
npx wrangler secret put RESEND_API_KEY           # optional: enables key-delivery / receipts / recovery emails
```

Email is optional: without `RESEND_API_KEY` + `EMAIL_FROM`, the product works
but sends no email (keys are shown once on screen, and recovery is disabled).
With them set, new keys are emailed, `/recover` re-sends a lost key, paid
upgrades get a receipt, and inactive free users get a nudge (via the daily
cron). The webhook should also subscribe to `invoice.payment_failed`.

## 3. Stripe

1. Create two recurring Prices: **Pro $19/mo**, **Business $49/mo**.
2. Paste their `price_...` ids into `wrangler.toml` (`STRIPE_PRICE_PRO`,
   `STRIPE_PRICE_BUSINESS`) and set `APP_URL` to your deployed domain. Redeploy.
3. Add a webhook endpoint → `https://<your-domain>/billing/webhook`, subscribed
   to `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`. Copy its signing secret into
   `STRIPE_WEBHOOK_SECRET` (step 2).

## 4. Legal (required before charging)

Set in `wrangler.toml` `[vars]` and redeploy:

```
LEGAL_ENTITY = "Your Company LLC"
LEGAL_EMAIL = "support@yourdomain.com"
LEGAL_JURISDICTION = "Delaware, USA"
```

Until these are set, `/terms`, `/privacy`, and `/refunds` render a
"template not finalized" warning. Have counsel review before taking real money.

## 5. Wire the autonomous loop to real metrics

In the repo root's `.auto-loop.env`:

```
METRICS_URL=https://<your-domain>/admin/metrics
METRICS_TOKEN=<the ADMIN_METRICS_TOKEN you set>
```

Now every cycle sees live signups / MRR / funnel data and optimizes against it.

## 6. Smoke test

```bash
curl "https://<your-domain>/health"                       # {"ok":true,...}
# register a key at https://<your-domain>/register?ref=smoke-test
curl "https://<your-domain>/og?title=Hello&key=sk_..." -o og.png
curl -H "Authorization: Bearer <ADMIN_METRICS_TOKEN>" \
     "https://<your-domain>/admin/metrics"                # signups/mrr/funnel JSON
```

## Redeploying

Just `./scripts/deploy.sh` again (or `npm run deploy`). It skips existing
resources and re-applies any new migrations.
