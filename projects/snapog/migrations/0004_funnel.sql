-- SnapOG D1 Schema
-- Migration 0004: conversion funnel events

-- Server-truthful funnel touchpoints so the loop can see WHERE money leaks:
--   limit_reached   -> a free key hit its quota (highest upgrade intent)
--   checkout_started -> user began Stripe checkout
--   converted        -> subscription became active (paying)
CREATE TABLE IF NOT EXISTS funnel_events (
  id          TEXT PRIMARY KEY,
  event       TEXT NOT NULL,
  api_key_id  TEXT,
  source      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_funnel_event ON funnel_events(event);
CREATE INDEX IF NOT EXISTS idx_funnel_created ON funnel_events(created_at);
