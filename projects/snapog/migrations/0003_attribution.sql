-- SnapOG D1 Schema
-- Migration 0003: acquisition attribution

-- Where a user came from (ref / utm_source), e.g. "producthunt", "reddit",
-- "cold-email", "seo". Defaults to "direct" when unknown.
ALTER TABLE users ADD COLUMN source TEXT NOT NULL DEFAULT 'direct';

CREATE INDEX IF NOT EXISTS idx_users_source ON users(source);
