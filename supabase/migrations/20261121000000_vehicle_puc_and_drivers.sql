-- Vehicle page → PUC certificate and the vehicle's drivers, with dates (owner, 21 Nov 2026). Run ONCE in the Supabase
-- Dashboard → SQL Editor as one script, after 20261118000200_tanker_transfer_adjustment_edit.sql. It opens its own
-- transaction: any error — or a guard below — changes nothing. NOT YET APPLIED to Production (needs the owner's go-ahead).
--
-- Why a migration:
--   * PUC: core.vehicles has insurance / road tax / fitness / permit dates (20261103000200) but no PUC date.
--   * Drivers: a vehicle names one driver (core.vehicles.default_driver_id, which pre-fills trips) and keeps no history
--     of who drove it. A vehicle with several drivers, over time, needs dated links. Each driver's DL number already
--     lives once, on the driver (core.drivers.license_no, 20261103000200): a link holds only ids and dates.
--   * Not the customer assignment (core.vehicle_assignments: which CUSTOMER a vehicle works for, one at a time, which
--     decides where every figure is reported). Driver periods decide no figure, and several drivers may overlap.
--
-- Changes (all additive; no existing row is updated or deleted; no backfill):
--   1. core.vehicles.puc_valid_till date, nullable (null = not recorded).
--   2. core.vehicle_driver_periods: driver D drove vehicle V from start_date to end_date (inclusive; null = still does).
--      Foreign keys to both masters (never deleted — archive only); end ≥ start; one driver's periods on one vehicle
--      never overlap (exclusion constraint — several different drivers may); at most one open period per vehicle and
--      driver (partial unique index); indexes for "drivers of a vehicle" and "vehicles of a driver".
--      A removal closes the period (end_date = the driver's last day); a re-assignment opens a new one.
--      The default driver stays on core.vehicles (trip pre-fill unchanged); the app lists it with the current drivers.
--   3. Audit, as every child row of a vehicle: any insert / update / delete needs the vehicle's audit event in the same
--      transaction (require_parent_audit_event, deferred). History is protected for every role except the Owner and
--      Dev (who hold vehicles:delete): an open period may be closed, a period closed today reopened, and a period that
--      started today removed (same-day undo — only inside the vehicle's audited edit whose "before" snapshot records it:
--      a new guard function, private.vehicle_driver_period_delete_guard(); private.edit_delete_guard() is NOT changed).
--      Older history can't be changed or removed by them.
--   4. RLS and grants mirror core.vehicles: read with vehicles / diesel / trips view; add with vehicles edit or create;
--      close / reopen / same-day remove with vehicles edit. OWNER, DEV and EMPLOYEE hold vehicles edit; the AdBlue
--      profiles don't. No permission row changes.
--
-- Deployment order: stage 1 of the four-stage deployment described in 20261122000000_vehicle_document_alerts.sql —
-- apply this, 20261121000100 and 20261122000000, and only then deploy the matching app (it reads
-- core.vehicle_driver_periods, puc_valid_till and core.vehicle_document_alerts). The current app keeps working after
-- this: it never reads either new object.
--
-- Verify afterwards (read-only):
--   select column_name, data_type, is_nullable from information_schema.columns where table_schema = 'core' and table_name = 'vehicles' and column_name = 'puc_valid_till';
--     → puc_valid_till | date | YES
--   select policyname, cmd from pg_policies where schemaname = 'core' and tablename = 'vehicle_driver_periods' order by cmd, policyname;
--     → Remove vehicle driver periods DELETE, Add vehicle driver periods INSERT, Read vehicle driver periods SELECT, Close vehicle driver periods UPDATE
--   select privilege_type from information_schema.role_table_grants where grantee = 'authenticated' and table_schema = 'core' and table_name = 'vehicle_driver_periods' order by 1;
--     → DELETE, INSERT, SELECT, UPDATE
--   select tgname from pg_trigger where tgrelid = 'core.vehicle_driver_periods'::regclass and not tgisinternal order by 1;
--     → vehicle_driver_periods_edit_delete, vehicle_driver_periods_require_audit, vehicle_driver_periods_touch
--   select count(*) from core.vehicle_driver_periods;  → 0
--   Then supabase/scripts/production-readonly/10-adblue-vendors-post-apply.sql: every row OK (it now knows this table).
-- Rollback (deploy the previous app first; roll back 20261122000100, then 20261122000000, first if applied — their
-- functions read puc_valid_till, the 20261122000100 trigger on every vehicle save): begin; drop table core.vehicle_driver_periods;
-- drop function private.vehicle_driver_period_delete_guard(); alter table core.vehicles drop column puc_valid_till; commit;

begin;

do $$
begin
  if to_regclass('core.vehicles') is null or to_regclass('core.drivers') is null
     or to_regprocedure('private.require_parent_audit_event()') is null or to_regprocedure('private.touch_updated_at()') is null
     or to_regprocedure('private.can(text, text)') is null or to_regprocedure('private.today_ist()') is null
     or to_regclass('fuel.industrial_supply_allocations') is null then
    raise exception 'Vehicle PUC / drivers migration stopped: apply 20261103000200 … 20261116000000 first. Nothing was changed.';
  end if;
  -- The no-overlap rule (section 2) is a GiST exclusion constraint on text ids, which needs btree_gist. It is created by
  -- 20261101000100_foundation.sql (in schema extensions) and already used by core.vehicle_status_periods,
  -- core.customer_status_periods and core.vehicle_assignments — checked here, never created or assumed.
  if not exists (select 1 from pg_extension where extname = 'btree_gist') then
    raise exception 'Vehicle PUC / drivers migration stopped: the btree_gist extension is not installed (20261101000100_foundation.sql creates it). Nothing was changed.';
  end if;
  if to_regclass('core.vehicle_driver_periods') is not null or to_regprocedure('private.vehicle_driver_period_delete_guard()') is not null
     or exists (select 1 from information_schema.columns where table_schema = 'core' and table_name = 'vehicles' and column_name = 'puc_valid_till') then
    raise exception 'Vehicle PUC / drivers migration stopped: it is already applied (fully or partly). Nothing was changed.';
  end if;
end $$;

/* ------------------------------------------------------------------ 1. PUC certificate */

alter table core.vehicles add column puc_valid_till date;
comment on column core.vehicles.puc_valid_till is 'PUC (Pollution Under Control) certificate valid till; null = not recorded.';

/* ------------------------------------------------------------------ 2. the vehicle's drivers, dated */

create table core.vehicle_driver_periods (
  id text primary key default private.new_id('vdp'),
  vehicle_id text not null references core.vehicles (id),
  driver_id text not null references core.drivers (id),
  start_date date not null,
  end_date date, -- inclusive; null = still drives it
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint vehicle_driver_periods_dates check (end_date is null or end_date >= start_date),
  constraint vehicle_driver_periods_no_overlap exclude using gist (vehicle_id with =, driver_id with =, daterange(start_date, end_date, '[]') with &&)
);
create unique index vehicle_driver_periods_open_key on core.vehicle_driver_periods (vehicle_id, driver_id) where end_date is null;
create index vehicle_driver_periods_vehicle_idx on core.vehicle_driver_periods (vehicle_id, start_date);
create index vehicle_driver_periods_driver_idx on core.vehicle_driver_periods (driver_id, start_date);
comment on table core.vehicle_driver_periods is 'Which drivers drove which vehicle, and when (inclusive dates; open end = current). Not the customer assignment. Driver details (name, DL number) stay on core.drivers. Changed only inside an audited vehicle edit.';

create trigger vehicle_driver_periods_touch before update on core.vehicle_driver_periods for each row execute function private.touch_updated_at();

/* ------------------------------------------------------------------ 3. audit */

create constraint trigger vehicle_driver_periods_require_audit after insert or update or delete on core.vehicle_driver_periods
  deferrable initially deferred for each row execute function private.require_parent_audit_event('vehicle_id');

-- Its own guard (as Tyre Data's tyre_item_delete_guard), so private.edit_delete_guard() and every table it protects stay
-- exactly as applied. A period is removed by any role but the Owner / Dev only inside the vehicle's audited edit whose
-- "before" snapshot records that period (src/lib/types.ts field names); RLS further limits them to a period started today.
create function private.vehicle_driver_period_delete_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.erp_role() is null or private.can('vehicles', 'delete') then
    return null;
  end if;
  if not exists (
    select 1 from audit.events e
    where e.txid = txid_current() and e.record_id = old.vehicle_id and e.action = 'UPDATED' and e.after is not null
      and e.before @> jsonb_build_object('driverPeriods', jsonb_build_array(jsonb_build_object('id', old.id, 'driverId', old.driver_id, 'startDate', old.start_date)))
  ) then
    raise exception 'Only the Owner and Dev can delete records: a core.vehicle_driver_periods row (vehicle %) is removed only by an audited edit of its vehicle.', old.vehicle_id
      using errcode = 'insufficient_privilege';
  end if;
  return null;
end $$;
revoke all on function private.vehicle_driver_period_delete_guard() from public, anon, authenticated;

create constraint trigger vehicle_driver_periods_edit_delete after delete on core.vehicle_driver_periods
  deferrable initially deferred for each row execute function private.vehicle_driver_period_delete_guard();

/* ------------------------------------------------------------------ 4. grants and RLS */

revoke all on core.vehicle_driver_periods from public, anon, authenticated;
grant all on core.vehicle_driver_periods to service_role;
grant select, insert, update, delete on core.vehicle_driver_periods to authenticated;

alter table core.vehicle_driver_periods enable row level security;
create policy "Read vehicle driver periods" on core.vehicle_driver_periods for select to authenticated
  using ((select private.can('vehicles', 'view')) or (select private.can('diesel', 'view')) or (select private.can('trips', 'view')));
create policy "Add vehicle driver periods" on core.vehicle_driver_periods for insert to authenticated
  with check ((select private.can('vehicles', 'edit')) or (select private.can('vehicles', 'create')));
-- Close an open period, or reopen one closed today (a removal undone the same day). Older history: Owner / Dev only.
create policy "Close vehicle driver periods" on core.vehicle_driver_periods for update to authenticated
  using ((select private.can('vehicles', 'delete'))
         or ((select private.can('vehicles', 'edit')) and (end_date is null or end_date >= private.today_ist())))
  with check ((select private.can('vehicles', 'delete')) or (select private.can('vehicles', 'edit')));
-- A period that started today, removed the same day (an add undone): besides the Owner / Dev, only inside the
-- vehicle's audited edit (vehicle_driver_period_delete_guard). History is never deleted by them.
create policy "Remove vehicle driver periods" on core.vehicle_driver_periods for delete to authenticated
  using ((select private.can('vehicles', 'delete'))
         or ((select private.can('vehicles', 'edit')) and start_date >= private.today_ist()));

commit;
