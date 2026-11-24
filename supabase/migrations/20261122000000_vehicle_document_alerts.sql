-- Vehicle document expiry alerts — resolved alert history (owner, 22 Nov 2026). Run ONCE in the Supabase Dashboard →
-- SQL Editor as one script, after 20261121000000_vehicle_puc_and_drivers.sql (its only new prerequisite: the PUC column)
-- and, in the recommended order, after 20261121000100_driver_licence_unique.sql (independent: it doesn't need it). It
-- opens its own transaction: any error — or a guard below — changes nothing. NOT YET APPLIED to Production (needs the
-- owner's go-ahead). Pre-flight: supabase/scripts/production-readonly/20-vehicle-documents-preflight.sql.
-- Stage 1 of the four-stage deployment (below): this creates the history and its checks; the vehicle-side lifecycle enforcement is only ACTIVATED by
-- 20261122000100_vehicle_document_alert_enforcement.sql, after the app that writes the history is deployed and verified.
--
-- Why a migration:
--   * Active alerts are not stored. They follow from the expiry dates already on core.vehicles and today's IST date,
--     calculated by the app on every read (src/domain/compliance.ts activeDocumentAlerts; warning periods Insurance 7,
--     Road tax 5, PUC 30, Fitness 30 days; Permit raises none until its period is confirmed) — no job, nothing missed.
--   * What must be stored is what the dates alone can't show once they change: an alert that ended because its
--     document's expiry date was updated, with the old date. That history is this table.
--
-- Changes (all additive — one new table and two functions; nothing on core.vehicles changes; no existing row, column,
-- trigger, grant or policy is changed; no backfill):
--   1. core.vehicle_document_alerts: one row per resolved alert — vehicle, document, registration at the time, the
--      expiry date the alert was for, the day the alert began, the date it was updated to (null = removed / Not
--      recorded), when, and vehicle_version: core.vehicles.updated_at as written by the save that resolved it.
--   2. No duplicate or invalid history (one row per expiry cycle, only from a real resolution):
--      * unique (vehicle_id, document, vehicle_version): one row per document per vehicle save. Every save of a vehicle
--        stamps a new updated_at (vehicles_touch, clock_timestamp()), so a repeated insert, a retried statement or a
--        second row for the same save is refused.
--      * private.vehicle_document_alert_guard() (deferred, at COMMIT, on each history row): the row belongs to the
--        vehicle's latest save, made in THIS transaction — vehicle_version = the vehicle's updated_at, and the vehicle
--        row's xmin is this transaction's id (exact: an earlier or a concurrent transaction's save never matches,
--        whatever the clocks say; a save inside a SAVEPOINT is refused — the app uses none); the vehicle now holds
--        new_expiry_date for that document; and the vehicle's audit event in this transaction (UPDATED / ARCHIVED /
--        RESTORED) records the change from expiry_date (before) to new_expiry_date (after).
--      * private.vehicle_document_alert_lifecycle() (section 2b) — created here but NOT attached to any table: the
--        trigger that runs it (at COMMIT, on every insert and update of core.vehicles) is 20261122000100. Once active:
--        the rows this transaction stamped with a save's updated_at must be EXACTLY the alerts that save resolved,
--        computed from the vehicle's own OLD / NEW rows (no session can forge them): each document whose date changed
--        while its alert was active on today's IST date, for a vehicle not Inactive / Archived before the save — the
--        app's resolvedByEdit. So raw SQL can't change an alerting date without its history row, nor add a row a save
--        didn't resolve (notes-only save, new vehicle, date not yet in its warning period, wrong old / alert / new date).
--        One UPDATE per save: a second UPDATE of the same vehicle in one transaction after an alerting date change is
--        refused (its row would no longer be the latest save's); the app writes each vehicle once per request.
--        An expiry cycle ends once: after that save the vehicle holds the new date, so the same date can only be
--        resolved again after a later save set it back — a genuinely new cycle, which is kept as its own row.
--      * A retried request from the app is refused before it reaches here (the edit carries the version it read —
--        optimistic concurrency), and the app only writes a row when the stored date differs from the new one.
--   3. Append-only: authenticated sessions get SELECT and INSERT only — no UPDATE or DELETE grant, so no role (Owner and
--      Dev included) can change or remove history through a session. Every row also needs the vehicle's audit event in
--      the same transaction (require_parent_audit_event, deferred).
--   4. RLS: read with vehicles:view; add with vehicles:edit (OWNER, DEV, EMPLOYEE). The AdBlue profiles hold neither:
--      they read and write nothing here. No permission row changes.
--   Document names = the app's ResolvedDocumentAlert["document"] (src/lib/types.ts); the snapshot paths in the guard =
--   the Vehicle fields (insurance.validTill, roadTax.validTill, fitnessValidTill, pucValidTill); the warning periods in
--   the lifecycle function = ALERT_LEAD_DAYS (src/domain/compliance.ts). check:document-alerts pins all three against the
--   app. "Today" is the database's IST date at the transaction's start (private.today_ist()); the app's is read moments
--   later — a save straddling 00:00 IST can be refused once (nothing saved; saving again works).
--
-- Deployment order (four stages):
--   1. 20-vehicle-documents-preflight.sql (every CHECK OK) → 20261121000000 → 20261121000100 → this →
--      21-vehicle-documents-post-apply.sql (every CHECK OK). The current app keeps working unchanged: nothing it writes
--      is checked by these (it never writes core.vehicle_document_alerts, and no trigger on core.vehicles is added).
--   2. Deploy the matching app (it reads core.vehicle_document_alerts and core.vehicle_driver_periods on every vehicle
--      load, and writes the history rows).
--   3. Verify it: 22-vehicle-document-alerts-activation-preflight.sql — every CHECK OK (the app has saved vehicles, and
--      every alert those saves resolved has its history row, transaction by transaction).
--   4. 20261122000100_vehicle_document_alert_enforcement.sql → 23-vehicle-document-alerts-enforcement-post-apply.sql.
-- Rollback (newest first; deploy the previous app before rolling this back — it reads the table):
--   roll back 20261122000100 first if applied, then
--   begin; drop table core.vehicle_document_alerts; drop function private.vehicle_document_alert_lifecycle();
--   drop function private.vehicle_document_alert_guard(); commit;
--   (with 20261122000100 still applied, drop function …lifecycle() fails and the whole rollback changes nothing.)

begin;

do $$
begin
  if to_regclass('core.vehicles') is null or to_regprocedure('private.require_parent_audit_event()') is null
     or to_regprocedure('private.can(text, text)') is null or to_regprocedure('private.new_id(text)') is null
     or to_regprocedure('private.touch_updated_at()') is null or to_regclass('audit.events') is null
     or not exists (select 1 from information_schema.columns where table_schema = 'core' and table_name = 'vehicles' and column_name = 'puc_valid_till')
     or not exists (select 1 from pg_trigger where tgrelid = 'core.vehicles'::regclass and tgname = 'vehicles_touch' and not tgisinternal) then
    raise exception 'Vehicle document alerts migration stopped: apply 20261103000200 … 20261121000000 first. Nothing was changed.';
  end if;
  if to_regclass('core.vehicle_document_alerts') is not null or to_regprocedure('private.vehicle_document_alert_guard()') is not null
     or to_regprocedure('private.vehicle_document_alert_lifecycle()') is not null then
    raise exception 'Vehicle document alerts migration stopped: it is already applied (fully or partly). Nothing was changed.';
  end if;
end $$;

/* ------------------------------------------------------------------ 1. the history */

create table core.vehicle_document_alerts (
  id text primary key default private.new_id('vda'),
  vehicle_id text not null references core.vehicles (id),
  document text not null check (document in ('Insurance', 'Road tax', 'Fitness', 'PUC')),
  reg_no text not null,
  expiry_date date not null,      -- the expiry date the alert was for
  alert_date date not null,       -- the day the alert began (expiry − the document's warning period)
  new_expiry_date date,           -- what it was updated to; null = removed (Not recorded)
  resolved_at timestamptz not null default clock_timestamp(),
  vehicle_version timestamptz not null, -- core.vehicles.updated_at written by the save that resolved it
  constraint vehicle_document_alerts_dates check (alert_date <= expiry_date),
  constraint vehicle_document_alerts_changed check (new_expiry_date is distinct from expiry_date),
  constraint vehicle_document_alerts_once unique (vehicle_id, document, vehicle_version)
);
comment on table core.vehicle_document_alerts is 'Resolved vehicle document expiry alerts: the old expiry date, when its alert began and when the date was updated. Append-only history, one row per expiry cycle, written only by the vehicle save that changed the date. Active alerts are calculated from core.vehicles, never stored.';

/* ------------------------------------------------------------------ 2. one row per expiry cycle, from a real change */

create function private.vehicle_document_alert_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  path text[] := case new.document when 'Insurance' then '{insurance,validTill}' when 'Road tax' then '{roadTax,validTill}'
                                   when 'Fitness' then '{fitnessValidTill}' when 'PUC' then '{pucValidTill}' end;
  old_day text := to_char(new.expiry_date, 'YYYY-MM-DD');
  new_day text := coalesce(to_char(new.new_expiry_date, 'YYYY-MM-DD'), '');
  v core.vehicles;
  mine boolean;
  stored date;
begin
  select * into v from core.vehicles where id = new.vehicle_id;
  -- The vehicle row as it stands was written by THIS transaction (its xmin is this transaction's id). Exact, unlike a
  -- clock comparison: never true for an earlier or a concurrent transaction's save, whatever the clocks say.
  select t.xmin::text::bigint = txid_current() % 4294967296 into mine from core.vehicles t where t.id = new.vehicle_id;
  stored := case new.document when 'Insurance' then v.insurance_valid_till when 'Road tax' then v.road_tax_valid_till
                              when 'Fitness' then v.fitness_valid_till when 'PUC' then v.puc_valid_till end;
  if v.updated_at is distinct from new.vehicle_version or mine is not true            -- the latest save, made in this transaction
     or stored is distinct from new.new_expiry_date                                    -- the vehicle now holds the new date
     or not exists (                                                                   -- and this save changed it from the old one
       select 1 from audit.events e
       where e.txid = txid_current() and e.record_id = new.vehicle_id and e.action in ('UPDATED', 'ARCHIVED', 'RESTORED')
         and e.before #>> path = old_day and coalesce(e.after #>> path, '') = new_day) then
    raise exception 'A % alert for vehicle % (expiry %) is recorded only by the vehicle save that changed that expiry date, once.', new.document, new.vehicle_id, old_day
      using errcode = 'integrity_constraint_violation';
  end if;
  return null;
end $$;
revoke all on function private.vehicle_document_alert_guard() from public, anon, authenticated;

create constraint trigger vehicle_document_alerts_cycle after insert on core.vehicle_document_alerts
  deferrable initially deferred for each row execute function private.vehicle_document_alert_guard();
create constraint trigger vehicle_document_alerts_require_audit after insert or update or delete on core.vehicle_document_alerts
  deferrable initially deferred for each row execute function private.require_parent_audit_event('vehicle_id');

/* ------------------------------------------------------------------ 2b. every save of a vehicle: exactly its alerts */

-- Dormant here: activated by 20261122000100 (trigger vehicles_document_alerts), once the app that writes the history
-- is deployed — so the previous app's vehicle edits are never refused by it.
-- The other direction, from the vehicle's own OLD / NEW rows (which no session can forge): at COMMIT, for every insert
-- and update of a vehicle, the history rows stamped with that save's updated_at must be EXACTLY the alerts the save
-- resolved — the documents whose date it changed while their alert was active on today's IST date (from expiry − the
-- warning period; Insurance 7, Road tax 5, Fitness 30, PUC 30; Permit none), for a vehicle that raised alerts before
-- the save (not Inactive / Archived: src/domain/compliance.ts raisesAlerts, resolvedByEdit). So a date changed by raw
-- SQL without its history row is refused, and so is a row a save didn't resolve (a notes-only save, an insert, a date
-- that wasn't in its warning period, wrong alert / new dates). A save that changes nothing alertable needs no row.
create function private.vehicle_document_alert_lifecycle() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  due jsonb := '[]';
  kept jsonb;
begin
  if tg_op = 'UPDATE' and old.status not in ('INACTIVE', 'ARCHIVED') then
    select coalesce(jsonb_agg(jsonb_build_object('document', d, 'expiry', was, 'alert', was - lead, 'next', nxt) order by d), '[]') into due
    from (values ('Insurance', old.insurance_valid_till, new.insurance_valid_till, 7),
                 ('Road tax', old.road_tax_valid_till, new.road_tax_valid_till, 5),
                 ('Fitness', old.fitness_valid_till, new.fitness_valid_till, 30),
                 ('PUC', old.puc_valid_till, new.puc_valid_till, 30)) as t(d, was, nxt, lead)
    where nxt is distinct from was and private.today_ist() >= was - lead;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('document', a.document, 'expiry', a.expiry_date, 'alert', a.alert_date, 'next', a.new_expiry_date) order by a.document), '[]') into kept
  from core.vehicle_document_alerts a where a.vehicle_id = new.id and a.vehicle_version = new.updated_at
    and a.xmin::text::bigint = txid_current() % 4294967296; -- this transaction's rows (another's were checked at its COMMIT)
  if kept is distinct from due then
    raise exception 'Vehicle % (save at %): the document alert history must record exactly the alerts this save resolved — expected %, found %.', new.id, new.updated_at, due, kept
      using errcode = 'integrity_constraint_violation';
  end if;
  return null;
end $$;
revoke all on function private.vehicle_document_alert_lifecycle() from public, anon, authenticated;

/* ------------------------------------------------------------------ 3–4. append-only grants and RLS */

revoke all on core.vehicle_document_alerts from public, anon, authenticated;
grant all on core.vehicle_document_alerts to service_role;
grant select, insert on core.vehicle_document_alerts to authenticated;

alter table core.vehicle_document_alerts enable row level security;
create policy "Read vehicle document alerts" on core.vehicle_document_alerts for select to authenticated
  using ((select private.can('vehicles', 'view')));
create policy "Add vehicle document alerts" on core.vehicle_document_alerts for insert to authenticated
  with check ((select private.can('vehicles', 'edit')));

commit;
