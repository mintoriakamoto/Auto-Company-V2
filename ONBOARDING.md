# Onboarding — what YOU do vs what the AI does

This system runs an autonomous AI company that can build, deploy, and market
software. It **cannot** create your accounts or touch your money — those are
one-time human steps, by law (payment accounts require identity/KYC
verification) and by design (you want a human gate on anything financial).

This is the exact, ordered list of the human steps. Once they're done, the
loop operates entirely inside the credentials you provisioned.

## What the AI never does

- Create accounts (Cloudflare, Stripe, GitHub, bank) — these need email/phone/
  identity verification a bot can't (and legally shouldn't) clear.
- Move, withdraw, or access your money. It can read revenue *numbers*; it has
  no access to your Stripe balance or bank.
- Bypass the safety guard (`scripts/hooks/guard.sh`) that hard-blocks
  destructive/irreversible actions.

## One-time human setup

### 1. The engine (the AI's "brain")
Install and log into Claude Code (or Codex CLI) on the machine that will run
the loop. Verify: `claude --version`.

### 2. Cloudflare (hosting + database)
- Sign up at cloudflare.com.
- In `projects/snapog`: `npm install`, then `npx wrangler login` (OAuth in your
  browser). This authorizes deploys — the AI reuses this token.

### 3. Provision + deploy the product
```bash
cd projects/snapog
npm run preflight     # shows exactly what's still missing (green/red)
npm run setup         # creates D1 + R2, applies migrations, deploys
```
See [`projects/snapog/DEPLOY.md`](projects/snapog/DEPLOY.md) for the full walk.

### 4. Stripe (to actually get paid)
- Sign up at stripe.com and complete onboarding: your legal name/business,
  address, tax id, and **a bank account for payouts**. This is required KYC —
  no way around a human doing it once.
- Start in **test mode** (test API keys, fake cards, no real money) to prove
  the flow. Switch to **live mode** only when ready to charge real people.
- Create two recurring Prices (Pro $19/mo, Business $49/mo); paste their price
  ids into `wrangler.toml`.
- Set the secrets (values never leave your machine):
  ```bash
  npx wrangler secret put STRIPE_SECRET_KEY
  npx wrangler secret put STRIPE_WEBHOOK_SECRET
  npx wrangler secret put ADMIN_METRICS_TOKEN
  ```
- Add a webhook → `https://<your-domain>/billing/webhook` for the
  `customer.subscription.*` and `invoice.payment_failed` events.

### 5. Legal (required before charging)
Fill `LEGAL_ENTITY`, `LEGAL_EMAIL`, `LEGAL_JURISDICTION` in `wrangler.toml` and
redeploy. Until then `/terms`, `/privacy`, `/refunds` show a "not finalized"
warning. Have counsel glance at them before taking real money.

### 6. Wire the loop to real results
Copy `.auto-loop.env.example` → `.auto-loop.env` and set:
```
MAX_TOTAL_COST_USD=25                      # your spend ceiling
METRICS_URL=https://<your-domain>/admin/metrics
METRICS_TOKEN=<the ADMIN_METRICS_TOKEN>
```
Now `npm run preflight` should say **READY**, and every loop cycle sees live
signups / MRR / funnel and optimizes toward paying customers.

### 7. Run it
```bash
make start            # foreground, watch it work
# or: make install    # run as a background daemon
make status           # loop status + revenue scoreboard
```

## How the money actually reaches you

Customer's card → Stripe Checkout → **your** Stripe balance → automatic payout →
**your** bank account (rolling schedule; first payout held ~7–14 days for new
accounts). You "access funds" by connecting your bank in Stripe once; after
that it just arrives. The AI only ever sees the counts, never the balance or
the bank — and a leaked API key still can't redirect payouts, which only go to
your verified bank on file.

## Quick reference

| Command | What it does |
|---|---|
| `npm run preflight` | Are you ready to charge? (green/red checklist) |
| `npm run setup` | Provision Cloudflare resources + deploy |
| `make start` / `make status` | Run the loop / see status + revenue |
| `curl -H "Authorization: Bearer <TOKEN>" .../admin/metrics` | Live revenue + funnel JSON |
