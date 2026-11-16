-- ROLLBACK of 20261116000000_adblue_vendors_owner_dev_delete.sql. NOT read-only. Prepared for review — run only on the
-- owner's decision.
--
-- What is lost: the AdBlue vendor master (names, default rates, contacts) and every vendor link — which vendor each
-- purchase and each new vehicle draw belongs to — and the before_vendor_tracking marks. Run STEP 1 first and keep its
-- output (one JSON value). No purchase, draw, litre or rupee is removed: every purchase keeps its vendor name as text,
-- and stock goes back to one company pool (company stock and value are unchanged; per-draw costs return to the previous
-- app's costing). Audit events stay in audit.events (append-only): the vendor history remains readable.
-- The Employee's delete rights come back in the database (private.can as in 20261103000000_dev_owner_authority.sql, and
-- the six child-row DELETE policies as in 20261103000200_full_erp_schema.sql).
--
-- What it does, in one transaction (all or nothing):
--   1. private.can back to its exact previous definition, the six child-row DELETE policies back to theirs, and the
--      delete guard (edit_delete_guard, is_same_day_undo, four triggers) dropped;
--   2. drops the purchases' vendor constraint, then fuel.adblue_stock_movements and private.adblue_shortfall back to
--      their exact original definitions (20261101000300_fuel.sql; the view is dropped and re-created because a view
--      column can't be removed — it has no grants, only private.adblue_shortfall reads it);
--   3. drops the three new columns and fuel.adblue_vendors (its triggers, policies, index and grants go with it).
--   RESTRICT (the default) everywhere: if anything else has come to depend on these objects, it stops and changes
--   nothing. No other table is touched.
--
-- ORDER: deploy the app version WITHOUT AdBlue vendors first (it reads fuel.adblue_vendors and the vendor columns on
-- every AdBlue screen). Then STEP 1, then STEP 2. Afterwards 09-adblue-vendors-preflight.sql reports no STOP again.

-- STEP 1 — read-only backup: run this SELECT alone and save its result outside the database.
select jsonb_build_object(
  'exported_at', now(),
  'adblue_vendors', (select coalesce(jsonb_agg(to_jsonb(v) order by v.id collate "C"), '[]'::jsonb) from fuel.adblue_vendors v),
  'purchase_vendor', (select coalesce(jsonb_object_agg(p.id, p.vendor_id), '{}'::jsonb) from fuel.adblue_purchases p where p.vendor_id is not null),
  'entry_vendor', (select coalesce(jsonb_object_agg(e.id, jsonb_build_object('vendor_id', e.vendor_id, 'before_vendor_tracking', e.before_vendor_tracking)), '{}'::jsonb) from fuel.adblue_entries e)
) as adblue_vendors_backup;

-- STEP 2 — the rollback. Type the project ref into the first line to confirm, then run lines from "begin" to "commit".
-- select set_config('vt.confirm_adblue_vendors_rollback', 'dqnoducqiootfvkzskhu', false);
begin;
do $$
begin
  if current_setting('vt.confirm_adblue_vendors_rollback', true) is distinct from 'dqnoducqiootfvkzskhu' then
    raise exception 'Not confirmed: run select set_config(''vt.confirm_adblue_vendors_rollback'', ''<project ref>'', false) first. Nothing was changed.';
  end if;
  if to_regclass('fuel.adblue_vendors') is null then
    raise exception 'AdBlue vendors are not installed (fuel.adblue_vendors does not exist) — nothing to roll back. Nothing was changed.';
  end if;
end $$;

-- 1. private.can as in 20261103000000_dev_owner_authority.sql, word for word.
create or replace function private.can(resource text, action text default 'view') returns boolean
language sql stable security definer set search_path = '' as $$
  select (resource not in ('accounts', 'system') or private.erp_role() = 'DEV') and exists (
    select 1 from core.role_permissions rp
    where rp.role = private.erp_role() and rp.permission in ('*', resource || ':*', resource || ':' || action)
  )
$$;

-- 1b. The child-row DELETE policies as in 20261103000200_full_erp_schema.sql, word for word; the guard dropped.
drop policy "Delete assignments" on core.vehicle_assignments;
create policy "Undo assignments" on core.vehicle_assignments for delete to authenticated
  using ((select private.can('vehicles', 'edit')) and private.month_open(start_date));
drop policy "Add pricing" on core.customer_pricing;
drop policy "Edit pricing" on core.customer_pricing;
drop policy "Delete pricing" on core.customer_pricing;
create policy "Write pricing" on core.customer_pricing for all to authenticated
  using ((select private.can('customers', 'edit')) or (select private.can('customers', 'create')))
  with check ((select private.can('customers', 'edit')) or (select private.can('customers', 'create')));
drop policy "Undo customer status" on core.customer_status_periods;
create policy "Undo customer status" on core.customer_status_periods for delete to authenticated using ((select private.can('customers', 'edit')));
drop policy "Undo vehicle status" on core.vehicle_status_periods;
create policy "Undo vehicle status" on core.vehicle_status_periods for delete to authenticated using ((select private.can('vehicles', 'edit')));
drop trigger customer_status_periods_edit_delete on core.customer_status_periods;
drop trigger vehicle_status_periods_edit_delete on core.vehicle_status_periods;
drop trigger customer_route_rates_edit_delete on core.customer_route_rates;
drop trigger industrial_supply_allocations_edit_delete on fuel.industrial_supply_allocations;
drop function private.edit_delete_guard();
drop function private.is_same_day_undo(text, text, date);

-- 2. The stock view and check as in 20261101000300_fuel.sql, word for word.
alter table fuel.adblue_purchases drop constraint adblue_purchases_vendor_id_check;
drop view fuel.adblue_stock_movements;
create view fuel.adblue_stock_movements with (security_invoker = true) as
  select id, date, created_at, 0 as sort_rank, total_litres as litres from fuel.adblue_purchases
  union all
  select id, date, created_at, 1, -quantity_litres from fuel.adblue_entries where source = 'STOCK';

create or replace function private.adblue_shortfall() returns table (available numeric, needed numeric, on_date date)
language sql stable security definer set search_path = '' as $$
  with m as (
    select date, sort_rank, created_at, id, litres,
           sum(litres) over (order by date, sort_rank, created_at, id collate "C" rows between unbounded preceding and current row) as running
    from fuel.adblue_stock_movements
  )
  select running - litres, -litres, date from m where running < 0 order by date, sort_rank, created_at, id collate "C" limit 1
$$;

-- 3. The new columns and the vendor master.
alter table fuel.adblue_entries drop column before_vendor_tracking;
alter table fuel.adblue_entries drop column vendor_id;
alter table fuel.adblue_purchases drop column vendor_id;
drop table fuel.adblue_vendors;

commit;
