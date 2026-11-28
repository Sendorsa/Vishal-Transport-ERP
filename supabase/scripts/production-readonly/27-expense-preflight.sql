-- READ-ONLY. Run before 20261128000000_expense_schema.sql (Phase 2B). Every CHECK row must say OK; any STOP = don't apply.
-- A single SELECT over the system catalogs and counts — it changes nothing.
select check_no, check_name, expected, actual,
       case when kind = 'INFO' then 'INFO' when actual = expected then 'OK' else 'STOP' end as status
from (values
  (1, 'CHECK', 'driver master migration 20261127000000 applied first', 'applied',
      case when to_regclass('core.vehicle_company_periods') is not null and exists (select 1 from information_schema.columns where table_schema = 'core' and table_name = 'drivers' and column_name = 'father_name') then 'applied' else 'missing' end),
  (2, 'CHECK', 'expense schema absent', 'absent', case when to_regnamespace('expense') is null then 'absent' else 'PRESENT' end),
  (3, 'CHECK', 'prerequisite functions present', 'present',
      case when to_regprocedure('private.require_parent_audit_event()') is not null and to_regprocedure('private.touch_updated_at()') is not null
             and to_regprocedure('private.can(text, text)') is not null and to_regprocedure('private.month_open(date)') is not null
             and to_regprocedure('private.today_ist()') is not null and to_regprocedure('private.new_id(text)') is not null
             and to_regprocedure('private.erp_role()') is not null and to_regprocedure('private.is_dev()') is not null
             and to_regprocedure('private.current_profile_id()') is not null and to_regprocedure('private.is_owner_or_dev()') is not null
             and to_regprocedure('private.changed_modules(timestamptz)') is not null and to_regprocedure('private.module_resource(text)') is not null
           then 'present' else 'missing' end),
  (4, 'CHECK', 'no role_permissions row for expenses (Dev-only)', '0', (select count(*)::text from core.role_permissions where permission like 'expenses%')),
  (5, 'CHECK', 'companies VT and VTHPL', '2', (select count(*)::text from core.companies where code in ('VT', 'VTHPL'))),
  (6, 'CHECK', 'module_resource(Expense) not yet changed', 'audit', private.module_resource('Expense')),
  (7, 'CHECK', 'module_resource() = the repository text (the migration replaces it)', '51eb49b8bc5d0d6eb710f05644b6fd2b',
      (select md5(prosrc) from pg_proc where oid = to_regprocedure('private.module_resource(text)'))),
  (8, 'CHECK', 'changed_modules() = the repository text (the migration replaces it)', 'a99d47f13ad3a729cf7662902f34a91a',
      (select md5(prosrc) from pg_proc where oid = to_regprocedure('private.changed_modules(timestamptz)'))),
  (9, 'CHECK', 'btree_gist installed', 'installed', (select case when count(*) > 0 then 'installed' else 'missing' end from pg_extension where extname = 'btree_gist')),
  (10, 'INFO', 'vehicles · customers · drivers · audit events (compare with 28)', '',
      (select count(*)::text from core.vehicles) || ' · ' || (select count(*)::text from core.customers) || ' · ' || (select count(*)::text from core.drivers) || ' · ' || (select count(*)::text from audit.events)),
  (11, 'INFO', 'PostgreSQL', '', current_setting('server_version'))
) as t(check_no, kind, check_name, expected, actual)
order by check_no;
