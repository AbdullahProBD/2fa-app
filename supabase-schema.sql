-- ============================================================
-- 2FA Vault - Supabase Schema & Migration
-- Run this in Supabase SQL Editor (https://app.supabase.com)
--
-- The whole script is idempotent: it is safe on a fresh project
-- and on an existing database (section 3 upgrades older schemas).
-- ============================================================

-- ------------------------------------------------------------
-- 1. Tables (fresh setups)
-- ------------------------------------------------------------

-- Users table: stores admin credentials (single-user, but extensible)
create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  username text unique not null,
  password_hash text not null,
  -- PBKDF2 salt + iterations used to wrap the per-user vault key
  kek_salt text not null,
  kek_iterations integer not null default 310000 check (kek_iterations >= 100000),
  -- Wrapped vault key (encrypted with PBKDF2(password))
  wrapped_vault_key text not null, -- base64
  wrapped_vault_iv text not null,  -- base64
  wrapped_vault_tag text not null, -- base64
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Accounts table: encrypted 2FA entries belonging to a user
create table if not exists public.accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  label text not null,
  issuer text not null default '',
  type text not null default 'totp' check (type in ('totp', 'hotp')),
  digits integer not null default 6 check (digits between 6 and 8),
  period integer not null default 30 check (period between 15 and 60),
  algorithm text not null default 'SHA1' check (algorithm in ('SHA1', 'SHA256', 'SHA512')),
  counter bigint not null default 0 check (counter >= 0),
  group_name text not null default '',
  logo text not null default '',
  position double precision not null default 0,
  -- Encrypted TOTP secret (AES-256-GCM with vault key)
  ciphertext text not null, -- base64
  iv text not null,         -- base64
  auth_tag text not null,   -- base64
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Groups table: custom account groups. `id` is a text slug (client or server
-- generated) and is globally unique; every query is also scoped by user_id.
create table if not exists public.groups (
  id text primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  name text not null,
  logo text not null default '',
  position double precision not null default 0,
  collapsed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 2. Indexes
-- ------------------------------------------------------------
create index if not exists accounts_user_id_idx on public.accounts(user_id);
create index if not exists accounts_created_at_idx on public.accounts(user_id, created_at desc);
create index if not exists accounts_position_idx on public.accounts(user_id, position);
create index if not exists accounts_group_name_idx on public.accounts(user_id, group_name);
create index if not exists groups_user_id_idx on public.groups(user_id);
create index if not exists groups_position_idx on public.groups(user_id, position);

-- ------------------------------------------------------------
-- 3. Migrations for existing databases (no-ops on a fresh setup)
-- ------------------------------------------------------------
alter table public.accounts add column if not exists group_name text not null default '';
alter table public.accounts add column if not exists logo text not null default '';
update public.accounts set group_name = '' where group_name = 'General';

-- Drag-to-reorder: doubles allow fractional ordering so the server can insert
-- new items between existing ones without renumbering every row.
alter table public.accounts add column if not exists position double precision not null default 0;
alter table public.groups add column if not exists position double precision not null default 0;

-- Remembered accordion state: whether a group is collapsed when the user last
-- left it. Restored on every login and after every toggle.
alter table public.groups add column if not exists collapsed boolean not null default false;
alter table public.groups add column if not exists updated_at timestamptz not null default now();

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'accounts_counter_nonneg') then
    alter table public.accounts
      add constraint accounts_counter_nonneg check (counter >= 0) not valid;
  end if;
end $$;

-- ------------------------------------------------------------
-- 4. updated_at triggers
-- ------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_users_updated_at on public.users;
create trigger trg_users_updated_at
  before update on public.users
  for each row execute function public.set_updated_at();

drop trigger if exists trg_accounts_updated_at on public.accounts;
create trigger trg_accounts_updated_at
  before update on public.accounts
  for each row execute function public.set_updated_at();

drop trigger if exists trg_groups_updated_at on public.groups;
create trigger trg_groups_updated_at
  before update on public.groups
  for each row execute function public.set_updated_at();

-- ============================================================
-- 5. Row Level Security
-- We use the SERVICE ROLE key from the server, so RLS is bypassed
-- in our backend functions. But we still enable RLS as a safety
-- net in case the anon key is ever leaked.
-- ============================================================

alter table public.users enable row level security;
alter table public.accounts enable row level security;
alter table public.groups enable row level security;

-- No public policies = no public access. Service role bypasses RLS.
-- Belt and braces: also drop the default table grants for the API roles.
revoke all on public.users, public.accounts, public.groups from anon, authenticated;
