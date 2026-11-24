-- READ-ONLY. Stage 3 of the four-stage deployment: run AFTER the app that writes the vehicle document alert history is
-- deployed and has been used, and BEFORE 20261122000100_vehicle_document_alert_enforcement.sql. Every CHECK row must say
-- OK; any STOP = don't activate the enforcement yet. Changes nothing.
--
-- What it proves: every vehicle save made by the new app (its audit snapshot carries driverPeriods, which the previous
-- app's never does) that resolved an alert — a document whose expiry date it changed while that alert was active on the
-- save's IST date, for a vehicle not Inactive / Archived before it (the app's resolvedByEdit; warning periods Insurance 7,
-- Road tax 5, Fitness 30, PUC 30, Permit none) — has exactly its history row, written in the same transaction (the
-- row's xmin = the save's audit txid), and that no history row is unexplained. That is the rule the enforcement trigger
-- will apply to every later save, so OK here means activating it refuses nothing the app does.
-- Row 3 needs at least one vehicle save by the new app: wait for a real edit (ideally an updated expiry date) — never
-- create test data on Production. Row 7 lists any difference for diagnosis (a save at the stroke of 00:00 IST can be
-- judged on either day: check its time before treating it as a fault).
with saves as (
  select e.txid % 4294967296 as xid, e.record_id as vehicle_id, e.at, e.before, e.after
  from audit.events e
  where e.module = 'Vehicles' and e.record_type = 'Vehicle' and e.action in ('UPDATED', 'ARCHIVED', 'RESTORED')
    and e.after ? 'driverPeriods'
),
expected as (
  select s.xid, s.vehicle_id, p.document, nullif(s.before #>> p.path, '')::date as expiry_date, nullif(s.after #>> p.path, '')::date as new_expiry_date
  from saves s
  cross join (values ('Insurance', '{insurance,validTill}'::text[], 7), ('Road tax', '{roadTax,validTill}'::text[], 5),
                     ('Fitness', '{fitnessValidTill}'::text[], 30), ('PUC', '{pucValidTill}'::text[], 30)) as p(document, path, lead)
  where coalesce(s.before ->> 'status', '') not in ('INACTIVE', 'ARCHIVED')
    and nullif(s.before #>> p.path, '') is not null
    and nullif(s.after #>> p.path, '') is distinct from nullif(s.before #>> p.path, '')
    and (s.at at time zone 'Asia/Kolkata')::date >= nullif(s.before #>> p.path, '')::date - p.lead
),
recorded as (
  select a.xmin::text::bigint as xid, a.vehicle_id, a.document, a.expiry_date, a.new_expiry_date
  from core.vehicle_document_alerts a
),
missing as (select * from expected except all select * from recorded),
unexplained as (select * from recorded except all select * from expected),
diff as (
  select 'missing' as kind, * from missing union all select 'unexplained', * from unexplained
)
select check_no, check_name, expected, actual,
       case when kind = 'INFO' then 'INFO' when actual = expected then 'OK' else 'STOP' end as status
from (values
  (1, 'CHECK', '20261122000000 applied (history table, guard and dormant lifecycle function = repository)', 'applied',
      case when to_regclass('core.vehicle_document_alerts') is not null
             and (select md5(prosrc) from pg_proc where oid = to_regprocedure('private.vehicle_document_alert_guard()')) = '184775cc6b9587410de8e8ec3c591aca'
             and (select md5(prosrc) from pg_proc where oid = to_regprocedure('private.vehicle_document_alert_lifecycle()')) = '6c888d9c7ff74e517ce14b2ab50f1848'
           then 'applied' else 'missing or different' end),
  (2, 'CHECK', '20261122000100 (enforcement trigger) not yet applied', 'not applied',
      case when exists (select 1 from pg_trigger where tgrelid = 'core.vehicles'::regclass and tgname = 'vehicles_document_alerts') then 'applied' else 'not applied' end),
  (3, 'CHECK', 'the deployed app has saved at least one vehicle (audit snapshot with driverPeriods)', 'yes',
      case when exists (select 1 from saves) then 'yes' else 'no — wait for a real vehicle edit' end),
  (4, 'INFO', 'vehicle saves by the new app · alerts they resolved · history rows', '',
      (select count(*)::text from saves) || ' · ' || (select count(*)::text from expected) || ' · ' || (select count(*)::text from recorded)),
  (5, 'CHECK', 'alerts resolved by a new-app save with no history row in that transaction', '0',
      (select count(*)::text from missing)),
  (6, 'CHECK', 'history rows no save resolved (wrong document, dates, or transaction)', '0',
      (select count(*)::text from unexplained)),
  (7, 'INFO', 'differences (first 20): kind vehicle document expiry → new (transaction)', '',
      coalesce((select string_agg(format('%s %s %s %s → %s (%s)', kind, vehicle_id, document, expiry_date, coalesce(new_expiry_date::text, 'removed'), xid), '; ')
                from (select * from diff order by kind, vehicle_id, document, xid limit 20) d), 'none')),
  (8, 'INFO', 'PostgreSQL', '', current_setting('server_version'))
) as t(check_no, kind, check_name, expected, actual)
order by check_no;
