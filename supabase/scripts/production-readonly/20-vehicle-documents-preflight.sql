-- READ-ONLY. Stage 1 of the four-stage deployment: run before 20261121000000_vehicle_puc_and_drivers.sql,
-- 20261121000100_driver_licence_unique.sql and 20261122000000_vehicle_document_alerts.sql (and so before
-- 20261122000100_vehicle_document_alert_enforcement.sql, stage 4). Every CHECK row must say OK; any STOP = don't apply.
-- Changes nothing.
select check_no, check_name, expected, actual,
       case when kind = 'INFO' then 'INFO' when actual = expected then 'OK' else 'STOP' end as status
from (values
  (1, 'CHECK', 'btree_gist extension installed (needed by the driver-period no-overlap rule)', 'installed',
      (select case when count(*) > 0 then 'installed' else 'missing' end from pg_extension where extname = 'btree_gist')),
  (2, 'INFO', 'btree_gist: version · schema · exclusion constraints already using GiST in core', '',
      (select coalesce(max(e.extversion || ' · ' || n.nspname), 'none') from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = 'btree_gist')
      || ' · ' || (select string_agg(conrelid::regclass::text, ', ' order by conrelid::regclass::text) from pg_constraint where contype = 'x' and connamespace = 'core'::regnamespace)),
  (3, 'CHECK', 'earlier migrations present (functions, tables, columns, the vehicles touch trigger)', 'present',
      case when to_regprocedure('private.require_parent_audit_event()') is not null and to_regprocedure('private.touch_updated_at()') is not null
             and to_regprocedure('private.can(text, text)') is not null and to_regprocedure('private.today_ist()') is not null
             and to_regprocedure('private.new_id(text)') is not null and to_regclass('fuel.industrial_supply_allocations') is not null
             and to_regclass('audit.events') is not null and to_regclass('core.drivers') is not null
             and exists (select 1 from information_schema.columns where table_schema = 'core' and table_name = 'drivers' and column_name = 'license_no')
             and (select count(*) from information_schema.columns where table_schema = 'core' and table_name = 'vehicles'
                    and column_name in ('insurance_valid_till', 'road_tax_valid_till', 'fitness_valid_till', 'permit_valid_till', 'updated_at')) = 5
             and exists (select 1 from pg_trigger where tgrelid = 'core.vehicles'::regclass and tgname = 'vehicles_touch' and not tgisinternal)
           then 'present' else 'missing' end),
  (4, 'CHECK', '20261121000000 (PUC, driver periods) not yet applied', 'not applied',
      case when to_regclass('core.vehicle_driver_periods') is null and to_regprocedure('private.vehicle_driver_period_delete_guard()') is null
             and not exists (select 1 from information_schema.columns where table_schema = 'core' and table_name = 'vehicles' and column_name = 'puc_valid_till')
           then 'not applied' else 'applied (fully or partly)' end),
  (5, 'CHECK', '20261121000100 (DL number unique) not yet applied', 'not applied',
      case when to_regclass('core.drivers_license_no_key') is null then 'not applied' else 'applied' end),
  (6, 'CHECK', '20261122000000 (document alert history) not yet applied', 'not applied',
      case when to_regclass('core.vehicle_document_alerts') is null and to_regprocedure('private.vehicle_document_alert_guard()') is null
             and to_regprocedure('private.vehicle_document_alert_lifecycle()') is null
           then 'not applied' else 'applied (fully or partly)' end),
  (7, 'CHECK', '20261122000100 (document alert enforcement trigger, stage 4) not yet applied', 'not applied',
      case when not exists (select 1 from pg_trigger where tgrelid = 'core.vehicles'::regclass and tgname = 'vehicles_document_alerts')
           then 'not applied' else 'applied' end),
  (8, 'CHECK', 'drivers sharing a DL number (would stop 20261121000100; list: 19-driver-licence-duplicates.sql)', '0',
      (select count(*)::text from (select 1 from core.drivers where btrim(regexp_replace(license_no, '\s+', ' ', 'g')) <> ''
                                   group by upper(btrim(regexp_replace(license_no, '\s+', ' ', 'g'))) having count(*) > 1) d)),
  (9, 'INFO', 'vehicles · drivers (kept unchanged by all three)', '',
      (select count(*)::text from core.vehicles) || ' · ' || (select count(*)::text from core.drivers)),
  (10, 'INFO', 'PostgreSQL', '', current_setting('server_version'))
) as t(check_no, kind, check_name, expected, actual)
order by check_no;
