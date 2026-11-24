-- READ-ONLY. Stage 1 post-apply: run after 20261121000000, 20261121000100 and 20261122000000, BEFORE the app deploy and
-- 20261122000100 (row 14 expects the enforcement trigger not active yet). Every CHECK row must say OK. Changes nothing.
-- Then run 10-adblue-vendors-post-apply.sql too: every row OK (it classifies core.vehicle_driver_periods).
select check_no, check_name, expected, actual,
       case when kind = 'INFO' then 'INFO' when actual = expected then 'OK' else 'STOP' end as status
from (values
  -- 20261121000000: PUC and the vehicle's drivers
  (1, 'CHECK', 'core.vehicles.puc_valid_till', 'date YES',
      (select data_type || ' ' || is_nullable from information_schema.columns where table_schema = 'core' and table_name = 'vehicles' and column_name = 'puc_valid_till')),
  (2, 'CHECK', 'vehicle_driver_periods: policies', 'DELETE:Remove vehicle driver periods,INSERT:Add vehicle driver periods,SELECT:Read vehicle driver periods,UPDATE:Close vehicle driver periods',
      (select string_agg(cmd || ':' || policyname, ',' order by cmd, policyname) from pg_policies where schemaname = 'core' and tablename = 'vehicle_driver_periods')),
  (3, 'CHECK', 'vehicle_driver_periods: authenticated grants', 'DELETE,INSERT,SELECT,UPDATE',
      (select string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants where grantee = 'authenticated' and table_schema = 'core' and table_name = 'vehicle_driver_periods')),
  (4, 'CHECK', 'vehicle_driver_periods: triggers', 'vehicle_driver_periods_edit_delete,vehicle_driver_periods_require_audit,vehicle_driver_periods_touch',
      (select string_agg(tgname, ',' order by tgname) from pg_trigger where tgrelid = to_regclass('core.vehicle_driver_periods') and not tgisinternal)),
  (5, 'CHECK', 'vehicle_driver_periods: no-overlap exclusion constraint (btree_gist)', 'present',
      case when exists (select 1 from pg_constraint where conname = 'vehicle_driver_periods_no_overlap' and contype = 'x') then 'present' else 'missing' end),
  (6, 'CHECK', 'vehicle_driver_period_delete_guard() = repository', '4af5bce5d559d505a95658522507b46f',
      (select md5(prosrc) from pg_proc where oid = to_regprocedure('private.vehicle_driver_period_delete_guard()'))),
  -- 20261121000100: one DL number, one driver
  (7, 'CHECK', 'core.drivers_license_no_key (unique, non-blank, normalised)', 'present',
      case when exists (select 1 from pg_indexes where schemaname = 'core' and indexname = 'drivers_license_no_key' and indexdef like 'CREATE UNIQUE INDEX%') then 'present' else 'missing' end),
  -- 20261122000000: resolved document alert history
  (8, 'CHECK', 'vehicle_document_alerts: policies', 'INSERT:Add vehicle document alerts,SELECT:Read vehicle document alerts',
      (select string_agg(cmd || ':' || policyname, ',' order by cmd, policyname) from pg_policies where schemaname = 'core' and tablename = 'vehicle_document_alerts')),
  (9, 'CHECK', 'vehicle_document_alerts: authenticated grants (append-only: no UPDATE, no DELETE)', 'INSERT,SELECT',
      (select string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants where grantee = 'authenticated' and table_schema = 'core' and table_name = 'vehicle_document_alerts')),
  (10, 'CHECK', 'vehicle_document_alerts: triggers', 'vehicle_document_alerts_cycle,vehicle_document_alerts_require_audit',
      (select string_agg(tgname, ',' order by tgname) from pg_trigger where tgrelid = to_regclass('core.vehicle_document_alerts') and not tgisinternal)),
  (11, 'CHECK', 'vehicle_document_alerts: one row per document per vehicle save', 'UNIQUE (vehicle_id, document, vehicle_version)',
      (select pg_get_constraintdef(oid) from pg_constraint where conname = 'vehicle_document_alerts_once')),
  (12, 'CHECK', 'vehicle_document_alerts: documents (Permit: none until its warning period is confirmed)', 'Fitness,Insurance,PUC,Road tax',
      (select string_agg(m[1], ',' order by m[1]) from pg_constraint c, regexp_matches(pg_get_constraintdef(c.oid), '''([^'']+)''', 'g') as m
       where c.conrelid = to_regclass('core.vehicle_document_alerts') and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%document%')),
  (13, 'CHECK', 'vehicle_document_alert_guard() = repository', '184775cc6b9587410de8e8ec3c591aca',
      (select md5(prosrc) from pg_proc where oid = to_regprocedure('private.vehicle_document_alert_guard()'))),
  (14, 'CHECK', 'core.vehicles: lifecycle enforcement NOT active yet (stage 4, 20261122000100, after the app deploy) — the previous app keeps working', 'not active',
      case when exists (select 1 from pg_trigger where tgrelid = 'core.vehicles'::regclass and tgname = 'vehicles_document_alerts') then 'active' else 'not active' end),
  (15, 'CHECK', 'vehicle_document_alert_lifecycle() = repository (created dormant: no trigger runs it yet)', '6c888d9c7ff74e517ce14b2ab50f1848',
      (select md5(prosrc) from pg_proc where oid = to_regprocedure('private.vehicle_document_alert_lifecycle()'))),
  (16, 'CHECK', 'row level security on both new tables', 'on,on',
      (select string_agg(case when relrowsecurity then 'on' else 'OFF' end, ',') from pg_class where oid in (to_regclass('core.vehicle_driver_periods'), to_regclass('core.vehicle_document_alerts')))),
  (17, 'INFO', 'rows: driver periods · document alert history (both start empty)', '',
      (select count(*)::text from core.vehicle_driver_periods) || ' · ' || (select count(*)::text from core.vehicle_document_alerts)),
  (18, 'INFO', 'vehicles · drivers (unchanged — compare with the pre-flight)', '',
      (select count(*)::text from core.vehicles) || ' · ' || (select count(*)::text from core.drivers))
) as t(check_no, kind, check_name, expected, actual)
order by check_no;
