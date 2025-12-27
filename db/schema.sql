-- Database schema cleaned to keep only fields currently used by the app
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Ensure the users table exists with the minimal, useful columns
CREATE TABLE IF NOT EXISTS users (
  pau_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  whatsapp_id TEXT UNIQUE NOT NULL,
  first_name TEXT,
  last_name TEXT,
  email TEXT,
  instagram_id TEXT,
  facebook_id TEXT,
  tiktok_id TEXT,
  current_state TEXT,
  onboarding_step TEXT
);

-- Drop any legacy columns that are no longer used by the application
DO $$
DECLARE
  col RECORD;
BEGIN
  FOR col IN
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'users'
      AND table_schema = 'public'
      AND column_name NOT IN (
        'pau_id', 'whatsapp_id', 'first_name', 'last_name', 'email',
        'instagram_id', 'facebook_id', 'tiktok_id', 'current_state', 'onboarding_step'
      )
  LOOP
    EXECUTE format('ALTER TABLE public.users DROP COLUMN IF EXISTS %I CASCADE;', col.column_name);
  END LOOP;
END $$;

-- Align column defaults and constraints with the expected runtime behavior
ALTER TABLE users
  ALTER COLUMN pau_id SET DEFAULT gen_random_uuid(),
  ALTER COLUMN whatsapp_id SET NOT NULL;
