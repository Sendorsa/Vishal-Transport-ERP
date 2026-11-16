-- Post-apply check for 20261116000000_adblue_vendors_owner_dev_delete.sql. Run AFTER the migration's COMMIT, in the
-- Supabase SQL Editor of project dqnoducqiootfvkzskhu. READ-ONLY: a single SELECT over the system catalogs and the
-- AdBlue tables (counts only). Function fingerprints are the md5 of the repository's definitions. Before the migration
-- it fails (column "vendor_id" does not exist) — that is expected.
--
-- Output: check_no | check_name | expected | actual | status (OK / STOP; INFO = facts to note).
--   Row 10 classifies EVERY table an authenticated session may delete from:
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
guarded as (
  select n.nspname::text || '.' || c.relname::text as t from pg_trigger g join pg_class c on c.oid = g.tgrelid join pg_namespace n on n.oid = c.relnamespace
  where g.tgfoid = to_regprocedure('private.edit_delete_guard()')
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
      'core.customer_pricing=owner/dev; core.customer_route_rates=owner/dev + audited edit; core.customer_status_periods=owner/dev + same-day undo; core.vehicle_assignments=owner/dev; core.vehicle_status_periods=owner/dev + same-day undo; finance.payment_allocations=owner/dev; finance.payments=owner/dev; fuel.adblue_entries=owner/dev; fuel.adblue_purchases=owner/dev; fuel.diesel_entries=owner/dev; fuel.industrial_supplies=owner/dev; fuel.industrial_supply_allocations=owner/dev + audited edit; fuel.tanker_adjustments=owner/dev; fuel.tanker_loads=owner/dev; fuel.tanker_transfers=owner/dev; ops.trips=owner/dev',
      (select string_agg(t || '=' || c, '; ' order by t) from cls)),
  (11, 'CHECK', 'tables an Employee or AdBlue profile could delete from outside an audited edit', 'none',
      coalesce((select string_agg(t, ', ' order by t) from cls where c in ('UNPROTECTED', 'no policy')), 'none')),
  (12, 'CHECK', 'edit_delete_guard triggers (deferred, after delete)', 'core.customer_route_rates,core.customer_status_periods,core.vehicle_status_periods,fuel.industrial_supply_allocations',
      (select string_agg(t, ',' order by t) from guarded)),
  (20, 'CHECK', 'bulk purchases without a vendor', '0',
      (select count(*)::text from fuel.adblue_purchases where not opening and vendor_id is null)),
  (21, 'INFO', 'AdBlue vendors · entries marked before vendor tracking', '',
      (select (select count(*) from fuel.adblue_vendors)::text || ' vendors · ' || (select count(*) from fuel.adblue_entries where before_vendor_tracking)::text || ' entries'))
) as t(check_no, kind, check_name, expected, actual)
order by check_no;
