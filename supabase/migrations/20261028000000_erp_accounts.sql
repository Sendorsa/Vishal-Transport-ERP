-- Phase 1: ERP accounts and roles — the foundation for Google sign-in with Owner-managed invitations.
-- Additive only: no business tables and no data changes. Business data stays in the browser until a
-- separately approved migration phase.

create type public.erp_role as enum ('OWNER', 'DEV', 'ACCOUNTANT', 'OPS_MANAGER', 'EMPLOYEE');
create type public.account_status as enum ('INVITED', 'ACTIVE', 'DISABLED');

-- One row per ERP account. An invitation is a row with an email and a role but no auth user yet (INVITED).
-- Signing in with Google as that verified email links the auth user and activates the row (phase 2).
-- Google sign-in alone grants nothing: an auth user without an ACTIVE row has no ERP access.
-- Accounts are disabled, never deleted (deleting the auth user is refused while a row points at it).
create table public.profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references auth.users (id) on delete restrict,
  email text not null unique check (email = lower(btrim(email)) and email like '_%@_%'),
  full_name text,
  role public.erp_role not null,
  status public.account_status not null default 'INVITED',
  invited_by uuid references public.profiles (id),
  activated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_invited_has_no_user check (status <> 'INVITED' or user_id is null),
  constraint profiles_active_has_user check (status <> 'ACTIVE' or (user_id is not null and activated_at is not null))
);

create function public.profiles_touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger profiles_touch_updated_at before update on public.profiles
for each row execute function public.profiles_touch_updated_at();

-- Defence in depth: even if an UPDATE grant is added later (e.g. to let people edit their name), the
-- browser-facing roles can never create, delete, promote, activate or re-link an account. Role changes
-- happen only through server-side code that checks the caller is the Owner (phase 2).
create function public.profiles_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user in ('anon', 'authenticated') and (
    tg_op <> 'UPDATE'
    or (new.user_id, new.email, new.role, new.status, new.invited_by, new.activated_at, new.created_at)
       is distinct from (old.user_id, old.email, old.role, old.status, old.invited_by, old.activated_at, old.created_at)
  ) then
    raise exception 'ERP accounts and roles can only be changed by the Owner' using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;

create trigger profiles_guard before insert or update or delete on public.profiles
for each row execute function public.profiles_guard();

-- Supabase grants every new public table to anon and authenticated by default; take that back.
-- A signed-in user may read only their own account row. No insert, update or delete for anyone
-- through the Data API. (service_role bypasses this and must never reach the browser.)
alter table public.profiles enable row level security;
revoke all on table public.profiles from public, anon, authenticated;
grant select on table public.profiles to authenticated;

create policy "Read own account" on public.profiles
for select to authenticated
using (user_id = (select auth.uid()));
