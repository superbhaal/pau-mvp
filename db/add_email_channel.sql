-- Migration: add email channel support
-- Allow users to exist without a WhatsApp ID (email-only users)
ALTER TABLE users ALTER COLUMN whatsapp_id DROP NOT NULL;

-- Add unique index on email for user lookup via email channel
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique ON users (email) WHERE email IS NOT NULL;
