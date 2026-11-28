-- READ-ONLY. Run after 20261127000000_driver_master_company_periods.sql. Every CHECK row must say OK. Changes nothing.
select check_no, check_name, expected, actual,
       case when kind = 'INFO' then 'INFO' when actual = expected then 'OK' else 'STOP' end as status
from (values
  (1, 'CHECK', 'core.drivers: father_name · date_of_birth · address added', 'text NO · date YES · text NO',
      (select string_agg(data_type || ' ' || is_nullable, ' · ' order by array_position(array['father_name', 'date_of_birth', 'address'], column_name::text))
         from information_schema.columns where table_schema = 'core' and table_name = 'drivers' and column_name in ('father_name', 'date_of_birth', 'address'))),
  (2, 'CHECK', 'core.drivers.company_code nullable', 'YES',
      (select is_nullable from information_schema.columns where table_schema = 'core' and table_name = 'drivers' and column_name = 'company_code')),
  (3, 'CHECK', 'every driver still has its recorded company (run before deploying the new app, which saves new drivers without one)', '0',
      (select count(*)::text from core.drivers where company_code is null)),
  (4, 'CHECK', 'core.vehicle_company_periods exists, empty (no backfill)', '0',
      (select count(*)::text from core.vehicle_company_periods)),
  (5, 'CHECK', 'policies', 'Remove vehicle company periods DELETE, Add vehicle company periods INSERT, Read vehicle company periods SELECT, Close vehicle company periods UPDATE',
      (select string_agg(policyname || ' ' || cmd, ', ' order by cmd, policyname) from pg_policies where schemaname = 'core' and tablename = 'vehicle_company_periods')),
  (6, 'CHECK', 'grants to authenticated', 'DELETE, INSERT, SELECT, UPDATE',
      (select string_agg(privilege_type, ', ' order by privilege_type) from information_schema.role_table_grants where grantee = 'authenticated' and table_schema = 'core' and table_name = 'vehicle_company_periods')),
  (7, 'CHECK', 'triggers', 'vehicle_company_periods_edit_delete, vehicle_company_periods_require_audit, vehicle_company_periods_touch',
      (select string_agg(tgname, ', ' order by tgname) from pg_trigger where tgrelid = 'core.vehicle_company_periods'::regclass and not tgisinternal)),
  (8, 'CHECK', 'constraints: dates check, no-overlap exclusion, open-period unique index', 'c, x, open',
      (select string_agg(contype::text, ', ' order by contype) from pg_constraint where conrelid = 'core.vehicle_company_periods'::regclass and contype in ('c', 'x'))
      || ', ' || case when to_regclass('core.vehicle_company_periods_open_key') is not null then 'open' else 'missing' end),
  (9, 'CHECK', 'RLS enabled', 'true',
      (select relrowsecurity::text from pg_class where oid = 'core.vehicle_company_periods'::regclass)),
  (10, 'INFO', 'drivers · vehicles · driver periods (unchanged — compare with the preflight)', '',
      (select count(*)::text from core.drivers) || ' · ' || (select count(*)::text from core.vehicles) || ' · ' || (select count(*)::text from core.vehicle_driver_periods))
) as t(check_no, kind, check_name, expected, actual)
order by check_no;
