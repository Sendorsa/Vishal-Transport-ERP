-- Pre-flight for 20261117000300_tyre_payment_tds_edit.sql. Run BEFORE the migration in the Supabase SQL Editor of
-- project dqnoducqiootfvkzskhu: every CHECK row OK. READ-ONLY: a single SELECT over the system catalogs and the tyre
-- payment tables (counts and sums only). Note the INFO row: 14-tyre-payment-tds-post-apply.sql shows the same figures
-- after the migration (no payment changes). Row 7 STOP = voided payments exist: review them (the migration would stop). Before 20261117000100_tyre_payments.sql it fails (ops.tyre_payments does
-- not exist): apply that migration first.
--
-- Output: check_no | check_name | expected | actual | status (OK / STOP; INFO = facts to note).
select check_no, check_name, expected, actual,
       case when kind = 'INFO' then 'INFO' when actual = expected then 'OK' else 'STOP' end as status
from (values
  (1, 'CHECK', 'database', 'postgres', current_database()::text),
  (2, 'CHECK', 'tyre payments (20261117000100) applied', 'present',
      case when to_regclass('ops.tyre_payments') is not null and to_regclass('ops.tyre_payment_allocations') is not null
                and to_regprocedure('private.tyre_payment_check()') is not null and to_regprocedure('private.tyre_payment_guard()') is not null then 'present' else 'missing' end),
  (3, 'CHECK', 'this migration not applied yet (TDS columns, allocation delete guard)', 'absent',
      case when not exists (select 1 from information_schema.columns where table_schema = 'ops' and table_name = 'tyre_payments' and column_name in ('tds_rate', 'tds_amount'))
                and to_regprocedure('private.tyre_allocation_delete_guard()') is null then 'absent' else 'present' end),
  (4, 'CHECK', 'payment-mode constraint to replace', 'tyre_payments_mode_check',
      (select string_agg(conname, ',') from pg_constraint where conrelid = to_regclass('ops.tyre_payments') and conname = 'tyre_payments_mode_check')),
  (5, 'CHECK', 'helpers the migration uses', 'present',
      case when to_regprocedure('private.can(text,text)') is not null and to_regprocedure('private.erp_role()') is not null and to_regprocedure('private.month_open(date)') is not null then 'present' else 'missing' end),
  (6, 'INFO', 'payments · allocations · Σ amount (unchanged by the migration; every payment gets no TDS)', '',
      (select (select count(*) from ops.tyre_payments)::text || ' · ' || (select count(*) from ops.tyre_payment_allocations)::text || ' · '
              || (select coalesce(sum(amount), 0) from ops.tyre_payments)::text)),
  (7, 'CHECK', 'voided payments (voiding is replaced by deletion; the migration stops on any)', '0',
      (select count(*)::text from ops.tyre_payments where voided)),
  (8, 'CHECK', 'allocation foreign key to replace (on delete cascade)', 'tyre_payment_allocations_payment_id_fkey',
      (select string_agg(conname, ',') from pg_constraint where conrelid = to_regclass('ops.tyre_payment_allocations') and conname = 'tyre_payment_allocations_payment_id_fkey'))
) as t(check_no, kind, check_name, expected, actual)
order by check_no;
