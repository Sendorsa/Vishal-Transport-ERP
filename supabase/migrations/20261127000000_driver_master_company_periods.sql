-- Operations → Drivers: the central driver master and each vehicle's dated company (owner, 27 Nov 2026). Run ONCE in
-- the Supabase Dashboard → SQL Editor as one script, after 20261121000000_vehicle_puc_and_drivers.sql (it needs
-- core.vehicle_driver_periods). It opens its own transaction: any error — or a guard below — changes nothing.
-- NOT YET APPLIED to any project. Run supabase/scripts/production-readonly/24-driver-master-preflight.sql first (every
-- CHECK row OK), then this, then 25-driver-master-post-apply.sql.
--
-- Why a migration:
--   * Drivers: the master keeps name, phone, DL number and DL expiry; the Drivers page also records father's name, date
--     of birth and address.
--   * Company deployment (VT / VTHPL) is derived from the vehicles a driver drives, never typed on the driver. A vehicle
--     stores only its current company (core.vehicles.company_code), so a change of company would rewrite the past: the
--     dated company history makes "which company did this driver work for, and when" answerable.
--
-- Changes (all additive; no existing row is updated or deleted; no backfill):
--   1. core.drivers: father_name text not null default '', date_of_birth date (null = not recorded), address text not
--      null default ''. company_code becomes nullable: new drivers don't record it (it follows from their vehicles);
--      every existing driver keeps the value it has.
--   2. core.vehicle_company_periods: vehicle V belonged to company C from start_date to end_date (inclusive; null = now).
--      Foreign keys to the vehicle and core.companies; end ≥ start; one vehicle's periods never overlap (exclusion
--      constraint); at most one open period per vehicle. A vehicle with no row has always been its current company —
--      rows appear only when the app records a change (src/domain/drivers.ts withCompanyChange). No backfill.
--   3. Audit, as every child row of a vehicle: any insert / update / delete needs the vehicle's audit event in the same
--      transaction (require_parent_audit_event, deferred). A delete by any role but the Owner / Dev needs that event's
--      "before" snapshot to record the period (private.vehicle_company_period_delete_guard — a new function;
--      private.edit_delete_guard() and private.vehicle_driver_period_delete_guard() are NOT changed).
--   4. RLS and grants mirror core.vehicle_driver_periods: read with vehicles / diesel / trips view; add with vehicles edit
--      or create; close the open period, or change one changed today (a same-day correction), with vehicles edit;
--      remove only a period recorded today (a same-day undo). Older history: Owner / Dev only (vehicles delete).
--      OWNER, DEV and EMPLOYEE hold vehicles edit; the AdBlue profiles don't. No permission row changes.
--
-- Existing data: drivers, vehicles, driver periods, assignments, trips and audit events are not touched. Driver ids,
-- names and DL numbers are unchanged. No driver is merged or matched here.
--
-- Deploy order: apply this, then deploy the matching app (it reads the new columns and table). The current app keeps
-- working after this: it never reads them, and it writes company_code on every driver it saves.
--
-- Verify afterwards: supabase/scripts/production-readonly/25-driver-master-post-apply.sql — every CHECK row OK.
-- Rollback (deploy the previous app first): supabase/scripts/09-rollback-driver-master.sql — only while the additions hold
-- no data (no dated vehicle company, no father's name / date of birth / address, every driver with a company_code); it
-- stops otherwise and never fills in or changes a row. It drops the table and its guard function, the three columns, and
-- makes company_code NOT NULL again; check:expense-db runs it (round trip to the exact earlier state).

begin;

do $$
begin
  if to_regclass('core.vehicles') is null or to_regclass('core.drivers') is null or to_regclass('core.companies') is null
     or to_regclass('core.vehicle_driver_periods') is null
     or to_regprocedure('private.require_parent_audit_event()') is null or to_regprocedure('private.touch_updated_at()') is null
     or to_regprocedure('private.can(text, text)') is null or to_regprocedure('private.today_ist()') is null
     or to_regprocedure('private.erp_role()') is null or to_regprocedure('private.new_id(text)') is null then
    raise exception 'Driver master migration stopped: apply 20261103000200 … 20261121000000 first. Nothing was changed.';
  end if;
  if not exists (select 1 from pg_extension where extname = 'btree_gist') then
    raise exception 'Driver master migration stopped: the btree_gist extension is not installed. Nothing was changed.';
  end if;
  if to_regclass('core.vehicle_company_periods') is not null or to_regprocedure('private.vehicle_company_period_delete_guard()') is not null
     or exists (select 1 from information_schema.columns where table_schema = 'core' and table_name = 'drivers' and column_name in ('father_name', 'date_of_birth', 'address')) then
    raise exception 'Driver master migration stopped: it is already applied (fully or partly). Nothing was changed.';
  end if;
end $$;

/* ------------------------------------------------------------------ 1. driver details */

alter table core.drivers add column father_name text not null default '';
alter table core.drivers add column date_of_birth date;
alter table core.drivers add column address text not null default '';
alter table core.drivers alter column company_code drop not null;
comment on column core.drivers.father_name is 'Father''s name; '''' = not recorded.';
comment on column core.drivers.date_of_birth is 'Date of birth; null = not recorded.';
comment on column core.drivers.address is 'Address; '''' = not recorded.';
comment on column core.drivers.company_code is 'As recorded on older drivers; null on new ones. A driver''s company deployment is derived from their vehicles (core.vehicle_driver_periods × core.vehicle_company_periods).';

/* ------------------------------------------------------------------ 2. the vehicle's company, dated */

create table core.vehicle_company_periods (
  id text primary key default private.new_id('vcp'),
  vehicle_id text not null references core.vehicles (id),
  company_code text not null references core.companies (code),
  start_date date not null,
  end_date date, -- inclusive; null = current
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint vehicle_company_periods_dates check (end_date is null or end_date >= start_date),
  constraint vehicle_company_periods_no_overlap exclude using gist (vehicle_id with =, daterange(start_date, end_date, '[]') with &&)
);
create unique index vehicle_company_periods_open_key on core.vehicle_company_periods (vehicle_id) where end_date is null;
create index vehicle_company_periods_vehicle_idx on core.vehicle_company_periods (vehicle_id, start_date);
comment on table core.vehicle_company_periods is 'Which company (VT / VTHPL) a vehicle belonged to, and when (inclusive dates; open end = current). No row = always core.vehicles.company_code. Changed only inside an audited vehicle edit.';

create trigger vehicle_company_periods_touch before update on core.vehicle_company_periods for each row execute function private.touch_updated_at();

/* ------------------------------------------------------------------ 3. audit */

create constraint trigger vehicle_company_periods_require_audit after insert or update or delete on core.vehicle_company_periods
  deferrable initially deferred for each row execute function private.require_parent_audit_event('vehicle_id');

create function private.vehicle_company_period_delete_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.erp_role() is null or private.can('vehicles', 'delete') then
    return null;
  end if;
  if not exists (
    select 1 from audit.events e
    where e.txid = txid_current() and e.record_id = old.vehicle_id and e.action = 'UPDATED' and e.after is not null
      and e.before @> jsonb_build_object('companyPeriods', jsonb_build_array(jsonb_build_object('id', old.id, 'companyCode', old.company_code, 'startDate', old.start_date)))
  ) then
    raise exception 'Only the Owner and Dev can delete records: a core.vehicle_company_periods row (vehicle %) is removed only by an audited edit of its vehicle.', old.vehicle_id
      using errcode = 'insufficient_privilege';
  end if;
  return null;
end $$;
revoke all on function private.vehicle_company_period_delete_guard() from public, anon, authenticated;

create constraint trigger vehicle_company_periods_edit_delete after delete on core.vehicle_company_periods
  deferrable initially deferred for each row execute function private.vehicle_company_period_delete_guard();

/* ------------------------------------------------------------------ 4. grants and RLS */

revoke all on core.vehicle_company_periods from public, anon, authenticated;
grant all on core.vehicle_company_periods to service_role;
grant select, insert, update, delete on core.vehicle_company_periods to authenticated;

alter table core.vehicle_company_periods enable row level security;
create policy "Read vehicle company periods" on core.vehicle_company_periods for select to authenticated
  using ((select private.can('vehicles', 'view')) or (select private.can('diesel', 'view')) or (select private.can('trips', 'view')));
create policy "Add vehicle company periods" on core.vehicle_company_periods for insert to authenticated
  with check ((select private.can('vehicles', 'edit')) or (select private.can('vehicles', 'create')));
-- Close the open period (a new change), or correct one changed today. Older history: Owner / Dev only.
create policy "Close vehicle company periods" on core.vehicle_company_periods for update to authenticated
  using ((select private.can('vehicles', 'delete'))
         or ((select private.can('vehicles', 'edit')) and (end_date is null or (updated_at at time zone 'Asia/Kolkata')::date >= private.today_ist())))
  with check ((select private.can('vehicles', 'delete')) or (select private.can('vehicles', 'edit')));
-- A period recorded today, removed the same day (a change undone): besides the Owner / Dev, only inside the vehicle's
-- audited edit (vehicle_company_period_delete_guard). History is never deleted by them.
create policy "Remove vehicle company periods" on core.vehicle_company_periods for delete to authenticated
  using ((select private.can('vehicles', 'delete'))
         or ((select private.can('vehicles', 'edit')) and (created_at at time zone 'Asia/Kolkata')::date >= private.today_ist()));

commit;
