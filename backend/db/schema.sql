-- ═══════════════════════════════════════════════════════════════
-- ReplyMate Pro — Supabase Schema
-- Run this entire file in: Supabase → SQL Editor → New Query → Run
-- ═══════════════════════════════════════════════════════════════

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  license_key TEXT UNIQUE NOT NULL,
  plan TEXT NOT NULL DEFAULT 'trial', -- trial | pro | agency | expired
  trial_start TIMESTAMPTZ DEFAULT NOW(),
  trial_end TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '14 days'),
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  subscription_status TEXT, -- active | canceled | past_due
  subscription_end TIMESTAMPTZ,
  ebay_username TEXT,
  business_name TEXT,
  signature_name TEXT,
  reply_tone TEXT DEFAULT 'professional',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_active TIMESTAMPTZ DEFAULT NOW()
);

-- eBay accounts (supports multi-account/agency)
CREATE TABLE IF NOT EXISTS ebay_accounts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  ebay_username TEXT NOT NULL,
  ebay_token TEXT NOT NULL,
  ebay_refresh_token TEXT,
  token_expires_at TIMESTAMPTZ,
  is_primary BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Daily usage tracking
CREATE TABLE IF NOT EXISTS usage (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  replies_count INTEGER DEFAULT 0,
  rule_count INTEGER DEFAULT 0,
  mini_count INTEGER DEFAULT 0,
  large_count INTEGER DEFAULT 0,
  tokens_used INTEGER DEFAULT 0,
  cost_usd DECIMAL(10, 6) DEFAULT 0,
  UNIQUE(user_id, date)
);

-- Individual reply log
CREATE TABLE IF NOT EXISTS reply_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  intent TEXT,
  route TEXT, -- rule | mini | large
  model TEXT,
  customer_message TEXT,
  generated_reply TEXT,
  modify_instructions TEXT,
  latency_ms INTEGER,
  tokens_used INTEGER DEFAULT 0,
  cost_usd DECIMAL(10, 6) DEFAULT 0,
  status TEXT DEFAULT 'pending', -- pending | sent | archived
  source TEXT DEFAULT 'dom', -- dom | api | manual
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tone samples per user
CREATE TABLE IF NOT EXISTS tone_samples (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Saved conversations
CREATE TABLE IF NOT EXISTS saved_convos (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  buyer_name TEXT,
  customer_message TEXT,
  reply TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Indexes for fast queries ─────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_usage_user_date ON usage(user_id, date);
CREATE INDEX IF NOT EXISTS idx_reply_log_user ON reply_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_license ON users(license_key);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_ebay_accounts_user ON ebay_accounts(user_id);

-- ── Row Level Security (keeps each user's data private) ─────────────────
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE reply_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE tone_samples ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_convos ENABLE ROW LEVEL SECURITY;
ALTER TABLE ebay_accounts ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS (backend uses service key)
-- Public anon key can only read/write via backend API

-- ── Helper function: get total monthly usage for a user ─────────────────
CREATE OR REPLACE FUNCTION get_monthly_usage(p_user_id UUID)
RETURNS TABLE(total_replies BIGINT, total_cost DECIMAL) AS $$
  SELECT
    COALESCE(SUM(replies_count), 0) as total_replies,
    COALESCE(SUM(cost_usd), 0) as total_cost
  FROM usage
  WHERE user_id = p_user_id
    AND date >= DATE_TRUNC('month', CURRENT_DATE);
$$ LANGUAGE SQL STABLE;

-- ── DONE ────────────────────────────────────────────────────────────────
-- After running this, go back to the chat and confirm it worked.
