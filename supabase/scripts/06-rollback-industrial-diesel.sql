-- ROLLBACK of the Industrial Diesel migrations 20261112000100_industrial_tanker_allocations.sql and
-- 20261112000000_industrial_diesel_supply.sql. NOT read-only. Prepared for review — run only on the owner's decision.
--
-- !!! DESTRUCTIVE: dropping the two tables DESTROYS EVERY INDUSTRIAL SUPPLY RECORD AND EVERY TANKER ALLOCATION. !!!
--     There is no undo. Run STEP 1 first and keep its output (a JSON copy of every supply with its allocations).
--     Their audit events stay in audit.events (append-only, never deleted): the history remains readable, but the
--     records can't be restored from the Audit Log while the tables are gone.
--     The litres those supplies took out of the tankers go back into the tankers' stock (the draws disappear with
--     the allocations) — tanker stock, ledgers and carry-forward then read as before the feature.
--
-- What it does, in one transaction (all or nothing):
--   1. fuel.tanker_movements back to its exact original definition (20261101000300_fuel.sql) and original comment.
--      CREATE OR REPLACE keeps the view's owner and grants; it must come first — the view depends on both tables.
--   2. drops fuel.industrial_supply_allocations, then fuel.industrial_supplies (their triggers, policies, indexes,
--      constraints and grants go with them) — also when only migration 1 was applied (migration 2 failed);
--   3. drops the four functions only these migrations created.
--   Everything uses RESTRICT (the default): if anything else has come to depend on these objects, it stops and
--   changes nothing. It touches no other table: tanker loads, Diesel entries, transfers, adjustments, customers,
--   profiles and the audit trail are untouched.
--
-- ORDER: deploy the app version WITHOUT Industrial Diesel first. The current app reads fuel.industrial_supplies in every
-- tanker stock calculation (Diesel entries list included): with the tables gone it fails until it is rolled back too.
-- After the rollback: 06-adblue-preflight.sql / 05-post-apply-fingerprint.sql describe the database again (the
-- industrial pre-flight 07 reports OK on rows 20–25 and 100+).

-- STEP 1 — read-only backup: run this SELECT alone and save its result (one JSON value) outside the database.
select jsonb_build_object(
  'exported_at', now(),
  'industrial_supplies', (select coalesce(jsonb_agg(to_jsonb(s) || jsonb_build_object(
      'allocations', (select coalesce(jsonb_agg(to_jsonb(a) order by a.tanker_id collate "C"), '[]'::jsonb) from fuel.industrial_supply_allocations a where a.supply_id = s.id))
    order by s.date, s.id collate "C"), '[]'::jsonb) from fuel.industrial_supplies s),
  'row_counts', jsonb_build_object('fuel.industrial_supplies', (select count(*) from fuel.industrial_supplies),
                                   'fuel.industrial_supply_allocations', (select count(*) from fuel.industrial_supply_allocations))
) as industrial_backup;

-- STEP 2 — the rollback. Type the project ref into the first line to confirm, then run lines from "begin" to "commit".
-- select set_config('vt.confirm_industrial_rollback', 'dqnoducqiootfvkzskhu', false);
begin;
do $$
begin
  if current_setting('vt.confirm_industrial_rollback', true) is distinct from 'dqnoducqiootfvkzskhu' then
    raise exception 'Not confirmed: run select set_config(''vt.confirm_industrial_rollback'', ''<project ref>'', false) first. Nothing was changed.';
  end if;
  if to_regclass('fuel.industrial_supplies') is null then
    raise exception 'Industrial Diesel is not installed (fuel.industrial_supplies does not exist) — nothing to roll back. Nothing was changed.';
  end if;
  raise notice 'Removing % industrial supplies and % tanker allocations.', (select count(*) from fuel.industrial_supplies),
    case when to_regclass('fuel.industrial_supply_allocations') is null then 0
         else (xpath('/row/n/text()', query_to_xml('select count(*) as n from fuel.industrial_supply_allocations', false, true, '')))[1]::text::int end;
end $$;

-- 1. The original view (20261101000300_fuel.sql), word for word, and its original comment.
create or replace view fuel.tanker_movements with (security_invoker = true) as
  select id, tanker_id, date, created_at, case when opening then 'OPENING' else 'LOAD' end as kind, litres, 0 as sort_rank from fuel.tanker_loads
  union all
  select id, tanker_id, date, created_at, 'FILL', -litres, 3 from fuel.diesel_entries where tanker_id is not null
  union all
  select id, from_tanker_id, date, created_at, 'TRANSFER_OUT', -litres, 1 from fuel.tanker_transfers
  union all
  select id, to_tanker_id, date, created_at, 'TRANSFER_IN', litres, 2 from fuel.tanker_transfers
  union all
  select id, tanker_id, date, created_at, 'ADJUST', litres, case when litres < 0 then 3 else 0 end from fuel.tanker_adjustments;
comment on view fuel.tanker_movements is 'Signed stock movements per tanker in the app''s event order. Stock and its value are calculated from these, never stored.';

-- 2. The tables: allocations (child) first, then the supplies. "if exists" only for migration 2's objects, so the
--    script also rolls back a database where migration 1 succeeded and migration 2 did not.
drop table if exists fuel.industrial_supply_allocations;
drop table fuel.industrial_supplies;

-- 3. The functions only these migrations created (their triggers went with the tables).
drop function if exists private.industrial_allocation_check();
drop function if exists private.industrial_supply_stock_check();
drop function if exists private.industrial_supply_stock_lock();
drop function private.industrial_supply_stamp();
commit;
