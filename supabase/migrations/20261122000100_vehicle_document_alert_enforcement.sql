-- Vehicle document alert history — activate the database-level lifecycle enforcement (owner, 22 Nov 2026). Stage 4 of
-- the four-stage deployment of 20261122000000_vehicle_document_alerts.sql. Run ONCE in the Supabase Dashboard → SQL
-- Editor as one script, ONLY after:
--   1. 20261121000000, 20261121000100 and 20261122000000 are applied (21-vehicle-documents-post-apply.sql: every CHECK OK);
--   2. the app that writes the alert history is deployed; and
--   3. 22-vehicle-document-alerts-activation-preflight.sql shows every CHECK OK: the deployed app has saved vehicles, and
--      every alert those saves resolved has its history row (and no row is unexplained).
-- It opens its own transaction: any error — or the guard below — changes nothing. NOT YET APPLIED to Production (needs
-- the owner's go-ahead).
--
-- Why a separate migration: the trigger refuses a vehicle save whose resolved alerts have no history row. The previous
-- app writes none, so activating it before the new app is live would refuse the previous app's legitimate edits of an
-- expiry date inside its warning period. Applied after the new app, it refuses only what that app never does: raw SQL
-- that bypasses the lifecycle (a date changed without its row) or invents / duplicates history (a row a save didn't
-- resolve). The rule itself is private.vehicle_document_alert_lifecycle(), reviewed and created by 20261122000000.
--
-- Changes: one deferred constraint trigger on core.vehicles (after insert or update, for each row). No row, column,
-- function, grant, policy or permission changes; existing data is not read or checked (a deferred row trigger checks
-- only saves made after it exists). Every save by the Owner, Dev or Employee that the app makes keeps working; the
-- AdBlue profiles can't edit vehicles (unchanged).
-- Verify afterwards: supabase/scripts/production-readonly/23-vehicle-document-alerts-enforcement-post-apply.sql.
-- Rollback (instant; deactivates the enforcement only, the history and the app keep working):
--   drop trigger vehicles_document_alerts on core.vehicles;

begin;

do $$
begin
  if to_regclass('core.vehicle_document_alerts') is null or to_regprocedure('private.vehicle_document_alert_guard()') is null
     or to_regprocedure('private.vehicle_document_alert_lifecycle()') is null then
    raise exception 'Vehicle document alert enforcement stopped: apply 20261122000000 first (and deploy the app, then run 22-vehicle-document-alerts-activation-preflight.sql). Nothing was changed.';
  end if;
  if exists (select 1 from pg_trigger where tgrelid = 'core.vehicles'::regclass and tgname = 'vehicles_document_alerts') then
    raise exception 'Vehicle document alert enforcement stopped: it is already applied. Nothing was changed.';
  end if;
end $$;

create constraint trigger vehicles_document_alerts after insert or update on core.vehicles
  deferrable initially deferred for each row execute function private.vehicle_document_alert_lifecycle();

commit;
