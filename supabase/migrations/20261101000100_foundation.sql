-- Diesel database, phase 1 — design approved by the owner on 1 Nov 2026 (D-1 … D-18). See docs/SUPABASE_DIESEL_DATABASE_SCHEMA.md §2.
--
-- Schemas (one per business domain; later modules add their own, e.g. ops for trips, billing for invoices):
--   core     shared master data and cross-module controls (companies, customers, vehicles, drivers, month locks…)
--   fuel     Diesel Management: fuel stations, diesel entries, tankers, AdBlue
--   finance  money movements (phase 1: fuel station payments and TDS only)
--   audit    the append-only audit trail and the Owner's deletion reviews
--   private  helper functions used by policies and triggers — never exposed through the Data API

create schema if not exists extensions;
create extension if not exists btree_gist with schema extensions; -- exclusion constraints on date ranges

create schema core;
create schema fuel;
create schema finance;
create schema audit;
create schema private;

comment on schema core is 'Shared master data and cross-module controls. Reused by every module; never duplicated.';
comment on schema fuel is 'Diesel Management: fuel stations, diesel entries, diesel tankers, AdBlue.';
comment on schema finance is 'Money movements. Phase 1: fuel station payments and TDS only (payments_phase1_fuel_station_only).';
comment on schema audit is 'Append-only audit trail (events) and the Owner''s deletion reviews.';
comment on schema private is 'Helper functions for policies and triggers. Not exposed through the Data API.';

/* ------------------------------------------------------------------ generic helpers */

-- Ids keep the app's shape: <prefix>_<12 hex>, e.g. dsl_3f9a1c0b7d2e (src/lib/api/repository.ts newId).
create function private.new_id(prefix text) returns text
language sql volatile set search_path = '' as $$
  select prefix || '_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)
$$;

create function private.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end $$;

-- Business dates are India dates (CLAUDE.md "Dates, India time"), read from the database clock, never the device.
create function private.today_ist() returns date
language sql stable set search_path = '' as $$
  select (now() at time zone 'Asia/Kolkata')::date
$$;

-- Last day of the date's calendar month (TDS date).
create function private.month_end(d date) returns date
language sql immutable set search_path = '' as $$
  select (date_trunc('month', d::timestamp) + interval '1 month' - interval '1 day')::date
$$;

-- First day of a 'yyyy-MM' month.
create function private.month_start(month text) returns date
language sql immutable set search_path = '' as $$
  select make_date(left(month, 4)::int, right(month, 2)::int, 1)
$$;

-- Registration as compared everywhere (src/domain/tanker.ts normReg): letters and digits only, upper case.
create function private.norm_reg(reg text) returns text
language sql immutable set search_path = '' as $$
  select upper(regexp_replace(reg, '[^A-Za-z0-9]', '', 'g'))
$$;

-- Refuses a business date after today (India). Attached to every dated transaction table.
create function private.refuse_future_date() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.date > private.today_ist() then
    raise exception 'A record can''t be dated in the future (%).', new.date using errcode = 'check_violation';
  end if;
  return new;
end $$;

/* ------------------------------------------------------------------ identity and permissions */

-- The caller's ERP account: only an ACTIVE profile linked to the signed-in user. NULL = no ERP access.
create function private.current_profile_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select p.id from public.profiles p where p.user_id = (select auth.uid()) and p.status = 'ACTIVE'
$$;

create function private.erp_role() returns public.erp_role
language sql stable security definer set search_path = '' as $$
  select p.role from public.profiles p where p.user_id = (select auth.uid()) and p.status = 'ACTIVE'
$$;

-- Owner-only actions are tested by name, never through a shared permission (CLAUDE.md "Roles").
create function private.is_owner() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(private.erp_role() = 'OWNER', false)
$$;

create function private.is_owner_or_dev() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(private.erp_role() in ('OWNER', 'DEV'), false)
$$;

-- resource:action permissions, seeded exactly from MAP in src/lib/permissions.ts. Changed only by migrations
-- (no grant lets any API role write it); npm run check:supabase-diesel pins it equal to can().
create table core.role_permissions (
  role public.erp_role not null,
  permission text not null check (permission ~ '^(\*|[a-z]+:(\*|view|create|edit|delete|finance))$'),
  primary key (role, permission)
);
comment on table core.role_permissions is 'Mirrors MAP in src/lib/permissions.ts. Changed by migrations only.';

insert into core.role_permissions (role, permission) values
  ('OWNER', '*'),
  ('DEV', 'dashboard:*'), ('DEV', 'finance:*'), ('DEV', 'customers:*'), ('DEV', 'vehicles:*'), ('DEV', 'trips:*'),
  ('DEV', 'diesel:*'), ('DEV', 'invoices:*'), ('DEV', 'payments:*'), ('DEV', 'reports:*'), ('DEV', 'settings:*'),
  ('DEV', 'audit:*'),
  ('EMPLOYEE', 'dashboard:view'), ('EMPLOYEE', 'vehicles:view'), ('EMPLOYEE', 'trips:view'), ('EMPLOYEE', 'trips:create'),
  ('EMPLOYEE', 'trips:edit'), ('EMPLOYEE', 'diesel:view'), ('EMPLOYEE', 'diesel:create'), ('EMPLOYEE', 'diesel:edit');

-- Mirrors can(role, resource, action) in src/lib/permissions.ts.
create function private.can(resource text, action text default 'view') returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from core.role_permissions rp
    where rp.role = private.erp_role() and rp.permission in ('*', resource || ':*', resource || ':' || action)
  )
$$;

-- The permission needed to read a module's audit history (MODULE_RESOURCE in src/lib/api/index.ts).
-- Modules not listed (Month Lock, System) need the audit permission itself (Owner and Dev).
create function private.module_resource(module text) returns text
language sql immutable set search_path = '' as $$
  select case module
    when 'Diesel' then 'diesel' when 'AdBlue' then 'diesel' when 'Diesel Tanker' then 'diesel' when 'Fuel Stations' then 'diesel'
    when 'Payments' then 'payments' when 'Customers' then 'customers' when 'Vehicles' then 'vehicles'
    when 'Drivers' then 'settings' when 'Trips' then 'trips' when 'Invoices' then 'invoices' when 'Settings' then 'settings'
    else 'audit' end
$$;
