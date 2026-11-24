-- READ-ONLY. Stage 4 post-apply: run after 20261122000100_vehicle_document_alert_enforcement.sql. Every CHECK row must
-- say OK. Changes nothing. (21-vehicle-documents-post-apply.sql row 14 now says "active" — expected after stage 4.)
select check_no, check_name, expected, actual,
       case when kind = 'INFO' then 'INFO' when actual = expected then 'OK' else 'STOP' end as status
from (values
  (1, 'CHECK', 'core.vehicles: vehicles_document_alerts (deferred constraint trigger, after insert or update, each row)', 'DEFERRED INSERT,UPDATE ROW',
      (select case when tgdeferrable and tginitdeferred then 'DEFERRED ' else 'NOT DEFERRED ' end
              || concat_ws(',', case when tgtype & 4 > 0 then 'INSERT' end, case when tgtype & 16 > 0 then 'UPDATE' end, case when tgtype & 8 > 0 then 'DELETE' end)
              || case when tgtype & 1 > 0 then ' ROW' else ' STATEMENT' end
       from pg_trigger where tgrelid = 'core.vehicles'::regclass and tgname = 'vehicles_document_alerts' and tgconstraint <> 0)),
  (2, 'CHECK', 'it runs private.vehicle_document_alert_lifecycle() = repository', '6c888d9c7ff74e517ce14b2ab50f1848',
      (select md5(p.prosrc) from pg_trigger t join pg_proc p on p.oid = t.tgfoid where t.tgrelid = 'core.vehicles'::regclass and t.tgname = 'vehicles_document_alerts')),
  (3, 'CHECK', 'core.vehicles triggers (the earlier three unchanged, plus this one)', 'vehicles_document_alerts,vehicles_opening_guard,vehicles_require_audit,vehicles_touch',
      (select string_agg(tgname, ',' order by tgname) from pg_trigger where tgrelid = 'core.vehicles'::regclass and not tgisinternal)),
  (4, 'CHECK', 'vehicle_document_alerts: authenticated grants unchanged (append-only)', 'INSERT,SELECT',
      (select string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants where grantee = 'authenticated' and table_schema = 'core' and table_name = 'vehicle_document_alerts')),
  (5, 'INFO', 'vehicles · document alert history rows (unchanged by this migration — compare with 22)', '',
      (select count(*)::text from core.vehicles) || ' · ' || (select count(*)::text from core.vehicle_document_alerts))
) as t(check_no, kind, check_name, expected, actual)
order by check_no;
