-- READ-ONLY. Run before 20261127000000_driver_master_company_periods.sql. Every CHECK row must say OK; any STOP = don't
-- apply. The INFO rows are the driver data audit (owner, 27 Nov 2026): nothing is matched, merged or changed.
-- Changes nothing.
select check_no, check_name, expected, actual,
       case when kind = 'INFO' then 'INFO' when actual = expected then 'OK' else 'STOP' end as status
from (values
  (1, 'CHECK', 'earlier migrations present (driver periods, audit, helpers, btree_gist)', 'present',
      case when to_regclass('core.vehicle_driver_periods') is not null and to_regclass('core.companies') is not null and to_regclass('audit.events') is not null
             and to_regprocedure('private.require_parent_audit_event()') is not null and to_regprocedure('private.touch_updated_at()') is not null
             and to_regprocedure('private.can(text, text)') is not null and to_regprocedure('private.today_ist()') is not null
             and to_regprocedure('private.erp_role()') is not null and to_regprocedure('private.new_id(text)') is not null
             and exists (select 1 from pg_extension where extname = 'btree_gist')
           then 'present' else 'missing' end),
  (2, 'CHECK', '20261127000000 not yet applied', 'not applied',
      case when to_regclass('core.vehicle_company_periods') is null and to_regprocedure('private.vehicle_company_period_delete_guard()') is null
             and not exists (select 1 from information_schema.columns where table_schema = 'core' and table_name = 'drivers' and column_name in ('father_name', 'date_of_birth', 'address'))
           then 'not applied' else 'applied (fully or partly)' end),
  (3, 'CHECK', 'company codes VT and VTHPL exist', '2',
      (select count(*)::text from core.companies where code in ('VT', 'VTHPL'))),
  (4, 'INFO', 'drivers: total · active · inactive · archived', '',
      (select count(*)::text || ' · ' || count(*) filter (where status = 'ACTIVE') || ' · ' || count(*) filter (where status = 'INACTIVE') || ' · ' || count(*) filter (where status = 'ARCHIVED') from core.drivers)),
  (5, 'INFO', 'drivers: with a DL number · with DL expiry · with phone', '',
      (select count(*) filter (where btrim(license_no) <> '')::text || ' · ' || count(*) filter (where license_valid_till is not null) || ' · ' || count(*) filter (where btrim(phone) <> '') from core.drivers)),
  (6, 'INFO', 'drivers sharing a name (case and spaces ignored) — review by hand, never merged', '',
      coalesce((select string_agg(k || ' ×' || n, '; ' order by k) from (select upper(btrim(regexp_replace(name, '\s+', ' ', 'g'))) k, count(*) n from core.drivers group by 1 having count(*) > 1) d), 'none')),
  (7, 'INFO', 'drivers sharing a DL number (19-driver-licence-duplicates.sql lists them)', '',
      (select count(*)::text from (select 1 from core.drivers where btrim(license_no) <> '' group by upper(btrim(regexp_replace(license_no, '\s+', ' ', 'g'))) having count(*) > 1) d)),
  (8, 'INFO', 'drivers by recorded company: VT · VTHPL', '',
      (select count(*) filter (where company_code = 'VT')::text || ' · ' || count(*) filter (where company_code = 'VTHPL') from core.drivers)),
  (9, 'INFO', 'vehicles by company: VT · VTHPL', '',
      (select count(*) filter (where company_code = 'VT')::text || ' · ' || count(*) filter (where company_code = 'VTHPL') from core.vehicles)),
  (10, 'INFO', 'vehicles with a default driver · of them without a dated driver period (no start date known)', '',
      (select count(*)::text from core.vehicles where default_driver_id is not null) || ' · ' ||
      (select count(*)::text from core.vehicles v where v.default_driver_id is not null
         and not exists (select 1 from core.vehicle_driver_periods p where p.vehicle_id = v.id and p.driver_id = v.default_driver_id))),
  (11, 'INFO', 'dated driver periods: total · open', '',
      (select count(*)::text || ' · ' || count(*) filter (where end_date is null) from core.vehicle_driver_periods)),
  (12, 'INFO', 'drivers driving VT and VTHPL vehicles at once now (open periods)', '',
      (select count(*)::text from (select p.driver_id from core.vehicle_driver_periods p join core.vehicles v on v.id = p.vehicle_id
                                   where p.end_date is null group by p.driver_id having count(distinct v.company_code) > 1) d)),
  (13, 'INFO', 'drivers whose recorded company differs from every vehicle they drive now', '',
      (select count(*)::text from core.drivers d where exists (select 1 from core.vehicle_driver_periods p where p.driver_id = d.id and p.end_date is null)
         and not exists (select 1 from core.vehicle_driver_periods p join core.vehicles v on v.id = p.vehicle_id where p.driver_id = d.id and p.end_date is null and v.company_code = d.company_code))),
  (14, 'INFO', 'trips: with a driver · driver id not in the master', '',
      (select count(*) filter (where driver_id is not null)::text from ops.trips) || ' · ' ||
      (select count(*)::text from ops.trips t where t.driver_id is not null and not exists (select 1 from core.drivers d where d.id = t.driver_id))),
  (15, 'INFO', 'PostgreSQL', '', current_setting('server_version'))
) as t(check_no, kind, check_name, expected, actual)
order by check_no;
