-- DESTRUCTIVE — the owner-approved go-live reset of BUSINESS data (owner's authorisation, 3 Nov 2026).
-- Run ONLY after 01-inspect.sql and a verified 02-backup-business-data.sql, in the SQL Editor of project
-- dqnoducqiootfvkzskhu, as the default postgres role. One transaction: any error leaves everything as it was.
--
-- REMOVES (rows only — no table is dropped, truncated or altered):
--   customers (+ status periods, pricing, route rates), drivers, vehicles (+ status periods, assignments),
--   fuel stations (except the internal tanker source dv_tanker), tankers, diesel / petrol / EV entries, tanker loads,
--   transfers, adjustments, AdBlue purchases and entries, payments and vouchers (+ receipt allocations), trips,
--   invoices (+ lines).
-- KEEPS: auth.users, auth.identities (Google), public.profiles (every account and role), the audit trail (only
--   appended to), month locks, role permissions, companies, vehicle types, payment categories, app settings, dv_tanker,
--   the schema and the migration history.
-- AUDIT: every removed row gets a SYSTEM "DELETED" event with its full snapshot and the reason below, then one
--   DATA_RESET event marks the boundary (the app refuses to "restore" anything deleted before it).
--
-- STEP 1 — preview (read-only): run this SELECT alone and compare with the backup's row_counts.
select t as "table", (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %s', t), false, true, '')))[1]::text::int as rows
from unnest(array[
  'finance.payment_allocations', 'finance.payments', 'billing.invoice_line_trips', 'billing.invoice_lines', 'billing.invoices', 'ops.trips',
  'fuel.adblue_entries', 'fuel.adblue_purchases', 'fuel.diesel_entries', 'fuel.tanker_loads', 'fuel.tanker_transfers', 'fuel.tanker_adjustments',
  'fuel.tankers', 'core.vehicle_assignments', 'core.vehicle_status_periods', 'core.customer_route_rates', 'core.customer_pricing',
  'core.customer_status_periods', 'core.vehicles', 'core.drivers', 'core.customers', 'fuel.fuel_stations'
]) as t
where to_regclass(t) is not null;

-- STEP 2 — the reset. Type the project ref into the first line to confirm, then run lines from "begin" to "commit".
-- select set_config('vt.confirm_reset', 'dqnoducqiootfvkzskhu', false);
begin;
do $$
declare
  why constant text := 'Go-live reset of business data (owner-approved, 3 Nov 2026)';
  -- Children before parents (foreign keys). Tables with an "id" get one DELETED event per row; the child rows of a
  -- parent (periods, pricing, routes, lines, allocations) are covered by their parent's event.
  audited constant text[] := array['finance.payments', 'billing.invoices', 'ops.trips', 'fuel.adblue_entries', 'fuel.adblue_purchases',
    'fuel.diesel_entries', 'fuel.tanker_loads', 'fuel.tanker_transfers', 'fuel.tanker_adjustments', 'fuel.tankers', 'core.vehicles',
    'core.drivers', 'core.customers', 'fuel.fuel_stations'];
  t text;
  n bigint;
  profiles_before bigint := (select count(*) from public.profiles);
  identities_before bigint := (select count(*) from auth.identities);
  users_before bigint := (select count(*) from auth.users);
begin
  if current_setting('vt.confirm_reset', true) is distinct from 'dqnoducqiootfvkzskhu' then
    raise exception 'Not confirmed. Run: select set_config(''vt.confirm_reset'', ''dqnoducqiootfvkzskhu'', false); — on project dqnoducqiootfvkzskhu only.';
  end if;

  -- One SYSTEM deletion event per business row, with its full snapshot (written first; checked at COMMIT).
  foreach t in array audited loop
    if to_regclass(t) is null then continue; end if;
    execute format(
      'insert into audit.events (actor_kind, action, module, record_type, record_id, label, before, reason, note)
       select ''SYSTEM'', ''DELETED'', ''System'', %L, x.id, ''Go-live reset'', to_jsonb(x), %L, ''Business data cleared for the clean go-live''
       from %s x %s',
      t, why, t, case when t = 'fuel.fuel_stations' then 'where not x.is_tanker_source' else '' end);
  end loop;

  -- Invoiced trips are locked to their invoice: release them first (an invoice_id-only change, as cancelling does).
  if to_regclass('ops.trips') is not null then update ops.trips set invoice_id = null where invoice_id is not null; end if;

  foreach t in array array['finance.payment_allocations', 'finance.payments', 'billing.invoice_line_trips', 'billing.invoice_lines', 'billing.invoices', 'ops.trips',
    'fuel.adblue_entries', 'fuel.adblue_purchases', 'fuel.diesel_entries', 'fuel.tanker_loads', 'fuel.tanker_transfers', 'fuel.tanker_adjustments',
    'fuel.tankers', 'core.vehicle_assignments', 'core.vehicle_status_periods', 'core.customer_route_rates', 'core.customer_pricing',
    'core.customer_status_periods', 'core.vehicles', 'core.drivers', 'core.customers', 'fuel.fuel_stations'] loop
    if to_regclass(t) is null then continue; end if;
    execute format('delete from %s %s', t, case when t = 'fuel.fuel_stations' then 'where not is_tanker_source' else '' end);
    get diagnostics n = row_count;
    raise notice '% rows removed from %', n, t;
  end loop;

  insert into audit.events (actor_kind, action, module, record_type, record_id, label, reason, note)
  values ('SYSTEM', 'DATA_RESET', 'System', 'Data', 'workspace', 'Business data cleared for the clean go-live', why, 'supabase/scripts/03-reset-business-data.sql');

  -- Accounts are never touched (no business table cascades into them) — proven, not assumed.
  if (select count(*) from public.profiles) <> profiles_before or (select count(*) from auth.identities) <> identities_before
     or (select count(*) from auth.users) <> users_before then
    raise exception 'An account, identity or user would change — aborting.';
  end if;
  if not exists (select 1 from fuel.fuel_stations where id = 'dv_tanker' and is_tanker_source) then
    raise exception 'The internal tanker source dv_tanker is missing — aborting.';
  end if;
end $$;
commit;

-- STEP 3 — verify (read-only): every business table empty except dv_tanker; accounts unchanged (compare with 01-inspect.sql §3).
-- select (select count(*) from fuel.fuel_stations) as stations_left_should_be_1, (select count(*) from core.vehicles) as vehicles,
--        (select count(*) from fuel.diesel_entries) as fills, (select count(*) from finance.payments) as payments;
-- select role, status, count(*) from public.profiles group by 1, 2 order by 1, 2;
