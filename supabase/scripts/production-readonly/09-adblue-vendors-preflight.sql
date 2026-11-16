-- Pre-flight for 20261116000000_adblue_vendors_owner_dev_delete.sql (AdBlue vendors; delete = Owner / Dev only).
-- Run BEFORE the migration, in the Supabase SQL Editor of project dqnoducqiootfvkzskhu (check the URL first).
-- READ-ONLY: a single SELECT over the system catalogs, core.role_permissions, public.profiles (a count of Employee
-- accounts only — no email or name) and the two AdBlue tables. It writes nothing, creates nothing, locks nothing beyond
-- a normal read. Function fingerprints are the md5 of the repository's definitions (migrations through 20261112000100).
--
-- Output: check_no | check_name | expected | actual | status.
--   OK     = as required.
--   STOP   = do not apply the migration (the migration's own guards stop it too, with the same reason, for 3 and 30):
--     1        not the postgres database                               → wrong database / project
--     2        a prerequisite migration is missing                     → apply 20261111000200 and 20261112000100 first
--     3        the migration is already applied (fully or partly)
--     4–6      an object the migration replaces differs from the repository → inspect before replacing it
--     10–16,18 a DELETE path the migration would not cover, or that differs from the repository → the Owner / Dev rule
--              would not hold there (12: the six child-row policies it replaces must exist by these exact names)
--     30       a bulk purchase without a usable vendor name            → enter its vendor in the app (Purchase history
--                                                                          → Edit), then run this again
--     31       AdBlue stock is already below zero somewhere            → the records are inconsistent: inspect first
--   REVIEW = 32: vendor names that differ only by spaces / case become ONE vendor (owner-approved rule). If any group
--            is really two vendors, rename one purchase in the app first.
--   INFO   = facts to note (what the migration will create and mark); never a reason to stop on their own.
--            For the exact per-vendor stock after the cutover, run the offline report on Dev's read-only export:
--            npm run adblue:cutover -- <export.json>   (reads the file only; see scripts/adblue-cutover-report.ts).
with
k as (  -- every bulk purchase with its normalised vendor name (the migration's key)
  select id, date, created_at, opening, total_litres, vendor_name,
         lower(btrim(regexp_replace(coalesce(vendor_name, ''), '\s+', ' ', 'g'))) as key
  from fuel.adblue_purchases
),
src as (  -- stock sources: opening stock is one, each vendor key another; when each first had stock
  select case when opening then '(opening)' else key end as source, min(date) as since from k group by 1
),
draws as (select id, date, quantity_litres from fuel.adblue_entries where source = 'STOCK'),
biz(n) as (values ('core'), ('fuel'), ('finance'), ('ops'), ('billing'), ('audit')),
-- DELETE policies on rows that an EDIT removes (they keep `edit`, by design — see the migration's point 1)
edit_internal(t, p) as (values
  ('core.customer_pricing', 'Write pricing'), ('core.customer_route_rates', 'Write route rates'),
  ('core.customer_status_periods', 'Undo customer status'), ('core.vehicle_status_periods', 'Undo vehicle status'),
  ('core.vehicle_assignments', 'Undo assignments'), ('fuel.industrial_supply_allocations', 'Delete industrial allocations')),
pol as (
  select schemaname::text || '.' || tablename::text as t, policyname as p, coalesce(qual, '') as qual
  from pg_policies where cmd in ('DELETE', 'ALL') and schemaname in (select n from biz)
)
select check_no, check_name, expected, actual,
       case when kind = 'INFO' then 'INFO'
            when actual = expected then 'OK'
            when kind = 'REVIEW' then 'REVIEW'
            else 'STOP' end as status
from (values
  (1, 'CHECK', 'database', 'postgres', current_database()::text),
  (2, 'CHECK', 'prerequisites (AdBlue profiles, industrial allocations)', 'present',
      case when to_regproc('private.customer_in_scope') is not null and to_regclass('fuel.industrial_supply_allocations') is not null
             and to_regproc('private.today_ist') is not null and to_regproc('private.require_parent_audit_event') is not null then 'present' else 'missing' end),
  (3, 'CHECK', 'not applied yet (vendor table and columns)', 'absent',
      case when to_regclass('fuel.adblue_vendors') is null
             and not exists (select 1 from information_schema.columns where table_schema = 'fuel' and table_name in ('adblue_purchases', 'adblue_entries') and column_name in ('vendor_id', 'before_vendor_tracking'))
             and not exists (select 1 from pg_constraint where conname = 'adblue_purchases_vendor_id_check')
             and to_regproc('private.edit_delete_guard') is null and to_regproc('private.is_same_day_undo') is null
             and not exists (select 1 from pg_policies where (schemaname, tablename, policyname) in (('core', 'vehicle_assignments', 'Delete assignments'),
                   ('core', 'customer_pricing', 'Add pricing'), ('core', 'customer_pricing', 'Edit pricing'), ('core', 'customer_pricing', 'Delete pricing')))
           then 'absent' else 'present' end),
  (4, 'CHECK', 'private.can(text,text) = repository (20261103000000)', '41c81e8f4c88c576053f4bdc4a6dfe2e',
      (select md5(prosrc) from pg_proc where oid = to_regprocedure('private.can(text,text)'))),
  (5, 'CHECK', 'private.adblue_shortfall() = repository (20261101000300)', 'b4bd0b6230382db6d4a74c89ec3a63a1',
      (select md5(prosrc) from pg_proc where oid = to_regprocedure('private.adblue_shortfall()'))),
  (6, 'CHECK', 'fuel.adblue_stock_movements columns', 'id,date,created_at,sort_rank,litres',
      (select string_agg(attname, ',' order by attnum) from pg_attribute where attrelid = to_regclass('fuel.adblue_stock_movements') and attnum > 0 and not attisdropped)),

  -- Every DELETE path (item 4 of the review), on this database:
  (10, 'CHECK', 'record DELETE policies that check private.can(…, ''delete'')', '10',
      (select count(*)::text from pol where qual ~ 'private\.can\(''[a-z]+''::text, ''delete''::text\)'
         and (t, p) not in (select t, p from edit_internal))),
  (11, 'CHECK', 'DELETE policies that check neither delete nor a known edit', 'none',
      coalesce((select string_agg(t || ' "' || p || '"', '; ' order by t, p) from pol
                where (t, p) not in (select t, p from edit_internal) and qual !~ 'private\.can\(''[a-z]+''::text, ''delete''::text\)'), 'none')),
  (12, 'CHECK', 'the 6 child-row DELETE policies the migration tightens (exact names)', '6',
      (select count(*)::text from pol where (t, p) in (select t, p from edit_internal))),
  (13, 'CHECK', 'tables without row level security', 'none',
      coalesce((select string_agg(n.nspname::text || '.' || c.relname::text, ', ' order by n.nspname, c.relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                where c.relkind = 'r' and n.nspname in (select n from biz) and not c.relrowsecurity), 'none')),
  (14, 'CHECK', 'DELETE / TRUNCATE granted to anon, PUBLIC or erp_server; TRUNCATE to authenticated', 'none',
      coalesce((select string_agg(table_schema::text || '.' || table_name::text || ':' || grantee || ':' || privilege_type, ', ' order by table_schema, table_name, grantee, privilege_type)
                from information_schema.role_table_grants where table_schema in (select n from biz)
                  and ((privilege_type in ('DELETE', 'TRUNCATE') and grantee in ('anon', 'PUBLIC', 'erp_server')) or (privilege_type = 'TRUNCATE' and grantee = 'authenticated'))), 'none')),
  (15, 'CHECK', 'SECURITY DEFINER functions that delete, callable by authenticated (Dev-only by name)', 'public.set_account_role,public.set_customer_access',
      (select string_agg(n.nspname || '.' || p.proname, ',' order by n.nspname, p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where p.prosecdef and p.prosrc ~* '\mdelete\s+from' and has_function_privilege('authenticated', p.oid, 'execute')
         and n.nspname in ('public', 'private', 'core', 'fuel', 'finance', 'ops', 'billing', 'audit')
         and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e'))),
  (18, 'CHECK', 'erp_server: no BYPASSRLS, NOINHERIT, no table grants of its own', 'ok',
      case when exists (select 1 from pg_roles where rolname = 'erp_server' and not rolbypassrls and not rolinherit)
             and not exists (select 1 from information_schema.role_table_grants where grantee = 'erp_server') then 'ok' else 'differs' end),
  (16, 'CHECK', 'tables an authenticated session may DELETE from (each is covered by 10 or 12)', 'core.customer_pricing,core.customer_route_rates,core.customer_status_periods,core.vehicle_assignments,core.vehicle_status_periods,finance.payment_allocations,finance.payments,fuel.adblue_entries,fuel.adblue_purchases,fuel.diesel_entries,fuel.industrial_supplies,fuel.industrial_supply_allocations,fuel.tanker_adjustments,fuel.tanker_loads,fuel.tanker_transfers,ops.trips',
      (select string_agg(t, ',' order by t) from (select distinct table_schema::text || '.' || table_name::text as t from information_schema.role_table_grants
       where grantee = 'authenticated' and privilege_type = 'DELETE' and table_schema in (select n from biz)) g)),
  (17, 'INFO', 'ACTIVE Employee accounts (lose delete in the database)', '',
      (select count(*)::text from public.profiles where role::text = 'EMPLOYEE' and status::text = 'ACTIVE')),

  -- The AdBlue data the backfill reads (item 2 of the review):
  (30, 'CHECK', 'bulk purchases without a usable vendor name', '0',
      (select count(*)::text || coalesce(': ' || string_agg(id || ' (' || date || ', ' || total_litres || ' L)', '; ' order by date, id), '') from k where not opening and key = '')),
  (31, 'CHECK', 'AdBlue stock below zero anywhere (existing check)', 'none',
      coalesce((select 'short ' || needed || ' L on ' || on_date || ' (available ' || available || ' L)' from private.adblue_shortfall()), 'none')),
  (32, 'REVIEW', 'names that become one vendor (spaces / case ignored)', 'none',
      coalesce((select string_agg(g, '; ' order by g) from (
         select key || ' ← ' || string_agg(distinct '"' || vendor_name || '"', ' | ') as g from k where not opening and key <> '' group by key having count(distinct vendor_name) > 1) x), 'none')),
  (33, 'INFO', 'vendors the migration creates (one per name)', '',
      (select count(*)::text || coalesce(': ' || string_agg(name, '; ' order by name), '') from (
         select distinct on (key) btrim(regexp_replace(vendor_name, '\s+', ' ', 'g')) as name from k where not opening and key <> '' order by key, date, created_at, id) x)),
  (34, 'INFO', 'bulk purchases linked (count · litres) and opening stock', '',
      (select count(*) filter (where not opening)::text || ' · ' || coalesce(sum(total_litres) filter (where not opening), 0) || ' L; opening stock: '
              || coalesce(sum(total_litres) filter (where opening)::text || ' L', 'none') from k)),
  (35, 'INFO', 'stock draws marked before_vendor_tracking (count · litres); direct purchases', '',
      (select (select count(*)::text || ' · ' || coalesce(sum(quantity_litres), 0) || ' L' from draws) || '; direct: ' || (select count(*) from fuel.adblue_entries where source = 'DIRECT'))),
  (36, 'INFO', 'company AdBlue stock now (litres) — unchanged by the migration', '',
      (select (coalesce((select sum(total_litres) from k), 0) - coalesce((select sum(quantity_litres) from draws), 0))::text || ' L')),
  (37, 'INFO', 'stock sources (opening = one) · old draws dated after a 2nd source had stock (at most these can become unattributed)', '',
      (select count(*)::text || ' · ' || (select count(*) from draws where date >= (select since from src order by since offset 1 limit 1))::text || ' draws' from src))
) as t(check_no, kind, check_name, expected, actual)
order by check_no;
