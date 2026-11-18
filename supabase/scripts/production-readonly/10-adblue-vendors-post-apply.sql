-- Post-apply check for 20261116000000_adblue_vendors_owner_dev_delete.sql (rows 1–21) and, since 17 Nov 2026,
-- 20261117000000_tyre_data.sql (rows 30–37). Run after the Tyre Data migration's COMMIT, in the Supabase SQL Editor of
-- project dqnoducqiootfvkzskhu: every row OK. (Before the Tyre Data migration it fails: ops.tyre_masters does not exist.) READ-ONLY: a single SELECT over the system catalogs and the
-- AdBlue tables (counts only). Function fingerprints are the md5 of the repository's definitions. Before the migration
-- it fails (column "vendor_id" does not exist) — that is expected.
--
-- Output: check_no | check_name | expected | actual | status (OK / STOP; INFO = facts to note).
--   Row 10 classifies EVERY table an authenticated session may delete from (Tyre Data's two tables too, once
--   20261117000000_tyre_data.sql is applied — this check can be run again after it):
--     owner/dev                  every DELETE policy needs private.can(…, 'delete') — the Owner and Dev only
--     owner/dev + same-day undo  the Owner and Dev; any other role only the latest status period started today, and only
--                                inside the parent's audited edit (edit_delete_guard)
--     owner/dev + audited edit   the Owner and Dev; any other role only inside the parent's audited edit, whose "before"
--                                snapshot records the row (edit_delete_guard)
--     UNPROTECTED                anything else — STOP (row 11)
with
biz(n) as (values ('core'), ('fuel'), ('finance'), ('ops'), ('billing'), ('audit')),
del as (
  select distinct table_schema::text || '.' || table_name::text as t from information_schema.role_table_grants
  where grantee = 'authenticated' and privilege_type = 'DELETE' and table_schema in (select n from biz)
),
pol as (
  select schemaname::text || '.' || tablename::text as t, coalesce(qual, '') as q from pg_policies
  where cmd in ('DELETE', 'ALL') and schemaname in (select n from biz)
),
guarded as (  -- the child-row delete guards: edit_delete_guard, Tyre Data's tyre_item_delete_guard (20261117000000) and tyre_allocation_delete_guard (20261117000300)
  select n.nspname::text || '.' || c.relname::text as t, g.tgfoid = to_regprocedure('private.edit_delete_guard()') as core_guard
  from pg_trigger g join pg_class c on c.oid = g.tgrelid join pg_namespace n on n.oid = c.relnamespace
  where g.tgfoid in (to_regprocedure('private.edit_delete_guard()'), coalesce(to_regprocedure('private.tyre_item_delete_guard()'), 0),
                     coalesce(to_regprocedure('private.tyre_allocation_delete_guard()'), 0), -- tyre payment corrections (20261117000300)
                     coalesce(to_regprocedure('private.adblue_allocation_delete_guard()'), 0)) -- AdBlue supplier payments (20261118000000)
),
cls as (
  select d.t, case
    when not exists (select 1 from pol where pol.t = d.t) then 'no policy'
    when bool_and(p.q ~ 'private\.can\(''[a-z]+''::text, ''delete''::text\)' and p.q !~ '''(edit|create)''::text') then 'owner/dev'
    when bool_and(p.q ~ 'private\.can\(''[a-z]+''::text, ''delete''::text\)') and bool_or(p.q ~ 'is_same_day_undo') and d.t in (select t from guarded) then 'owner/dev + same-day undo'
    when d.t in (select t from guarded) then 'owner/dev + audited edit'
    else 'UNPROTECTED' end as c
  from del d left join pol p on p.t = d.t group by d.t
)
select check_no, check_name, expected, actual,
       case when kind = 'INFO' then 'INFO' when actual = expected then 'OK' else 'STOP' end as status
from (values
  (1, 'CHECK', 'database', 'postgres', current_database()::text),
  (2, 'CHECK', 'migration objects present', 'present',
      case when to_regclass('fuel.adblue_vendors') is not null and to_regproc('private.edit_delete_guard') is not null and to_regproc('private.is_same_day_undo') is not null
             and exists (select 1 from pg_constraint where conname = 'adblue_purchases_vendor_id_check') then 'present' else 'missing' end),
  (3, 'CHECK', 'private.can(text,text) = repository (delete: Owner / Dev)', '25040f389c9145e77b0f8b43b36e248f',
      (select md5(prosrc) from pg_proc where oid = to_regprocedure('private.can(text,text)'))),
  (4, 'CHECK', 'private.edit_delete_guard() = repository', 'f56a115975c52871de070dc7dd4fe68b',
      (select md5(prosrc) from pg_proc where oid = to_regprocedure('private.edit_delete_guard()'))),
  (5, 'CHECK', 'private.is_same_day_undo(text,text,date) = repository', 'd60dffacb8b319fc64295a5a4d6c0443',
      (select md5(prosrc) from pg_proc where oid = to_regprocedure('private.is_same_day_undo(text,text,date)'))),
  (6, 'CHECK', 'private.adblue_shortfall() = repository (per-vendor backstop)', '8cf1d74af06a3a956e0dd02b1e5ed445',
      (select md5(prosrc) from pg_proc where oid = to_regprocedure('private.adblue_shortfall()'))),
  (10, 'CHECK', 'delete rule of every table an authenticated session may delete from',
      (select string_agg(x, '; ' order by split_part(x, '=', 1)) from (values
        ('core.customer_pricing=owner/dev'), ('core.customer_route_rates=owner/dev + audited edit'), ('core.customer_status_periods=owner/dev + same-day undo'),
        ('core.vehicle_assignments=owner/dev'), ('core.vehicle_status_periods=owner/dev + same-day undo'), ('finance.payment_allocations=owner/dev'), ('finance.payments=owner/dev'),
        ('fuel.adblue_entries=owner/dev'), ('fuel.adblue_purchases=owner/dev'), ('fuel.diesel_entries=owner/dev'), ('fuel.industrial_supplies=owner/dev'),
        ('fuel.industrial_supply_allocations=owner/dev + audited edit'), ('fuel.tanker_adjustments=owner/dev'), ('fuel.tanker_loads=owner/dev'), ('fuel.tanker_transfers=owner/dev'), ('ops.trips=owner/dev'),
        -- Tyre Data (20261117000000), tyre payment corrections (20261117000300), AdBlue supplier payments (20261118000000): once applied
        (case when to_regclass('ops.tyre_invoices') is not null then 'ops.tyre_invoice_items=owner/dev + audited edit' end),
        (case when to_regclass('ops.tyre_invoices') is not null then 'ops.tyre_invoices=owner/dev' end),
        (case when to_regprocedure('private.tyre_allocation_delete_guard()') is not null then 'ops.tyre_payment_allocations=owner/dev + audited edit' end),
        (case when to_regprocedure('private.tyre_allocation_delete_guard()') is not null then 'ops.tyre_payments=owner/dev' end),
        (case when to_regclass('fuel.adblue_payments') is not null then 'fuel.adblue_payment_allocations=owner/dev + audited edit' end),
        (case when to_regclass('fuel.adblue_payments') is not null then 'fuel.adblue_payments=owner/dev' end)
      ) as e(x) where x is not null),
      (select string_agg(t || '=' || c, '; ' order by t) from cls)),
  (11, 'CHECK', 'tables an Employee or AdBlue profile could delete from outside an audited edit', 'none',
      coalesce((select string_agg(t, ', ' order by t) from cls where c in ('UNPROTECTED', 'no policy')), 'none')),
  (12, 'CHECK', 'edit_delete_guard triggers (deferred, after delete)', 'core.customer_route_rates,core.customer_status_periods,core.vehicle_status_periods,fuel.industrial_supply_allocations',
      (select string_agg(t, ',' order by t) from guarded where core_guard)),
  -- Tyre Data (20261117000000): its own objects, and that it changed none of the AdBlue ones (rows 3–6 and 10–12 above).
  (30, 'CHECK', 'Tyre: tables ops.tyre_masters, ops.tyre_invoices, ops.tyre_invoice_items', 'present',
      case when to_regclass('ops.tyre_masters') is not null and to_regclass('ops.tyre_invoices') is not null and to_regclass('ops.tyre_invoice_items') is not null then 'present' else 'missing' end),
  (31, 'CHECK', 'Tyre: permission rows (Dev holds *)', 'EMPLOYEE:tyres:*,OWNER:tyres:*',
      (select string_agg(role::text || ':' || permission, ',' order by role::text) from core.role_permissions where permission like 'tyres%')),
  (32, 'CHECK', 'Tyre: audit module → permission (history, change polling)', 'tyres',
      (select private.module_resource('Tyre'))),
  (33, 'CHECK', 'Tyre: row level security on all three tables', 'on,on,on',
      (select string_agg(case when c.relrowsecurity then 'on' else 'OFF' end, ',' order by c.relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'ops' and c.relname in ('tyre_masters', 'tyre_invoices', 'tyre_invoice_items'))),
  (34, 'CHECK', 'Tyre: tyre_item_delete_guard() = repository', '75c4cdc3243fc83f76f3f4c3b828c6c8',
      (select md5(prosrc) from pg_proc where oid = to_regprocedure('private.tyre_item_delete_guard()'))),
  (35, 'CHECK', 'Tyre: tyre_invoice_has_lines() = repository', '0175c1e84ab835fdc4dc4baae88ae0b8',
      (select md5(prosrc) from pg_proc where oid = to_regprocedure('private.tyre_invoice_has_lines()'))),
  (36, 'CHECK', 'Tyre: Office / No Customer — office ⇔ no customer (constraint)', 'present',
      case when exists (select 1 from pg_constraint where conrelid = to_regclass('ops.tyre_invoices') and contype = 'c' and pg_get_constraintdef(oid) like '%office%customer_id%') then 'present' else 'missing' end),
  (37, 'CHECK', 'Tyre: the 12 starting repair types', '12',
      (select count(*)::text from ops.tyre_masters where kind = 'REPAIR_TYPE' and name in ('New Tyre Purchased', 'Rebuilt Tyres', 'Wheel Alignment', 'Wheel Alignment Charge',
         'Wheel Tyre Fitting', 'Tyre Fitting', 'Wheel Rotation Work', 'Puncture Work', 'Tube', 'Flap', 'Wheel Balancing', 'Wheel Balance / Weights'))),
  (20, 'CHECK', 'bulk purchases without a vendor', '0',
      (select count(*)::text from fuel.adblue_purchases where not opening and vendor_id is null)),
  (21, 'INFO', 'AdBlue vendors · entries marked before vendor tracking', '',
      (select (select count(*) from fuel.adblue_vendors)::text || ' vendors · ' || (select count(*) from fuel.adblue_entries where before_vendor_tracking)::text || ' entries'))
) as t(check_no, kind, check_name, expected, actual)
order by check_no;
