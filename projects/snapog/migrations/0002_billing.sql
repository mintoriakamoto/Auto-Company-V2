-- SnapOG D1 Schema
-- Migration 0002: Stripe billing

-- Stripe customer + subscription state lives on the user.
ALTER TABLE users ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT;
-- Current paid tier at the account level (free | pro | business).
ALTER TABLE users ADD COLUMN billing_tier TEXT NOT NULL DEFAULT 'free';
ALTER TABLE users ADD COLUMN billing_status TEXT NOT NULL DEFAULT 'none';

CREATE INDEX IF NOT EXISTS idx_users_stripe_customer ON users(stripe_customer_id);

-- Processed Stripe webhook events, for idempotency + audit. A repeated
-- delivery of the same event id is ignored.
CREATE TABLE IF NOT EXISTS billing_events (
  id            TEXT PRIMARY KEY,          -- Stripe event id (evt_...)
  type          TEXT NOT NULL,
  user_id       TEXT,
  processed_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_billing_events_user ON billing_events(user_id);
