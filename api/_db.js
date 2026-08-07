import { supabaseAdmin } from './_supabase.js';

function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

export async function getCredits(email) {
  const { data, error } = await supabaseAdmin
    .from('credits')
    .select('balance')
    .eq('email', normalizeEmail(email))
    .maybeSingle();
  if (error) throw error;
  return data ? data.balance : 0;
}

// New emails get 1 free credit the first time their balance is checked,
// mirroring the "1 free design included" promise already in the UI copy.
// Returns the current (possibly newly-granted) balance.
export async function ensureWelcomeCredit(email) {
  const { data, error } = await supabaseAdmin.rpc('ensure_welcome_credit', { p_email: normalizeEmail(email) });
  if (error) throw error;
  return data;
}

export async function addCredits(email, amount) {
  const { data, error } = await supabaseAdmin.rpc('add_credits', { p_email: normalizeEmail(email), p_amount: amount });
  if (error) throw error;
  return data;
}

// Atomically decrements by 1 only if the balance is > 0 (see deduct_credit()
// in sql/schema.sql — a single UPDATE ... WHERE balance > 0 RETURNING,
// atomic under Postgres row locking). Returns the new balance, or null if
// there were no credits to spend.
export async function deductCredit(email) {
  const { data, error } = await supabaseAdmin.rpc('deduct_credit', { p_email: normalizeEmail(email) });
  if (error) throw error;
  return data === -1 ? null : data;
}

// Idempotency guard for Stripe webhook retries — the first call for a given
// event id succeeds (returns true), duplicate deliveries return false.
export async function markEventProcessed(eventId) {
  const { error } = await supabaseAdmin.from('stripe_events').insert({ event_id: eventId });
  if (!error) return true;
  if (error.code === '23505') return false; // unique_violation: already processed
  throw error;
}
