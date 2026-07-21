-- SnapOG D1 Schema
-- Migration 0006: coarse rate limiting (anti-abuse for /recover, /register)

CREATE TABLE IF NOT EXISTS rate_limits (
  k          TEXT PRIMARY KEY,   -- bucket key, e.g. "recover:user@x.com"
  count      INTEGER NOT NULL,
  window_ms  INTEGER NOT NULL    -- epoch ms when the current window started
);
