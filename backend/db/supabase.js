// db/supabase.js — Supabase client (uses service key for full access)
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY // service key bypasses RLS — backend only
);

module.exports = supabase;
