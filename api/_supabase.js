import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Service-role client: bypasses Row Level Security. Only ever used
// server-side, for admin user management (create/sign-out) and the credits
// / stripe_events tables — never expose this key to the browser.
export const supabaseAdmin = (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
  : null;

// Anon-key client: used for the auth operations that are meant to run as a
// specific end user (sign in, validate/refresh a session token), the same
// way a browser client would call them — never for direct table access.
export const supabaseAnon = (SUPABASE_URL && SUPABASE_ANON_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
  : null;

// Every route needs both clients (one for admin/table access, one for the
// user-facing auth calls) — check this rather than `supabaseAdmin` alone,
// or a missing anon key alone would slip past the guard and surface as an
// opaque 500 from deep inside signIn()/requireSessionUser() instead.
export const supabaseConfigured = Boolean(supabaseAdmin && supabaseAnon);
