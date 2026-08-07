-- Lamsa — Supabase schema.
-- Run this once in the Supabase project's SQL Editor (Database > SQL Editor)
-- after creating the project. Auth accounts themselves live in Supabase's
-- built-in auth.users table and need no setup here — this only covers the
-- credit ledger and Stripe webhook idempotency, which auth.users has no
-- room for.

create table if not exists public.credits (
  email text primary key,
  balance integer not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.stripe_events (
  event_id text primary key,
  processed_at timestamptz not null default now()
);

-- All access to both tables goes through the service_role key from the
-- serverless functions (api/_db.js), which bypasses RLS by design. Enabling
-- RLS with no policies simply blocks the anon/authenticated keys from ever
-- touching these tables directly, as defense in depth.
alter table public.credits enable row level security;
alter table public.stripe_events enable row level security;

-- Atomically decrements the balance by 1, only if it's currently > 0.
-- Returns the new balance, or -1 if there were no credits to spend.
create or replace function public.deduct_credit(p_email text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  new_balance integer;
begin
  update credits
  set balance = balance - 1, updated_at = now()
  where email = p_email and balance > 0
  returning balance into new_balance;

  if new_balance is null then
    return -1;
  end if;

  return new_balance;
end;
$$;

-- Adds p_amount credits, creating the row if it doesn't exist yet. Returns
-- the new balance.
create or replace function public.add_credits(p_email text, p_amount integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  new_balance integer;
begin
  insert into credits (email, balance)
  values (p_email, p_amount)
  on conflict (email) do update
    set balance = credits.balance + p_amount, updated_at = now()
  returning balance into new_balance;

  return new_balance;
end;
$$;

-- Grants the 1 free welcome credit the first time this is called for an
-- email; a no-op if the row already exists. Returns the current balance.
create or replace function public.ensure_welcome_credit(p_email text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  new_balance integer;
begin
  insert into credits (email, balance)
  values (p_email, 1)
  on conflict (email) do nothing;

  select balance into new_balance from credits where email = p_email;
  return new_balance;
end;
$$;
