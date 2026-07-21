-- SnapOG D1 Schema
-- Migration 0005: encrypted key at rest (enables email recovery)

-- base64(iv || AES-GCM ciphertext) of the raw key, encrypted with a key
-- derived from AUTH_SECRET. Lets us re-send a lost key to the owner's
-- verified email without storing it in plaintext.
ALTER TABLE api_keys ADD COLUMN key_encrypted TEXT;
