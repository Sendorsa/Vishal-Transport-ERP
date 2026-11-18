-- Post-apply check for 20261117000300_tyre_payment_tds_edit.sql. Run right after the migration's COMMIT in the Supabase
-- SQL Editor of project dqnoducqiootfvkzskhu: every CHECK row OK (row 9 only right after the migration — before anyone
-- records TDS). Compare the INFO row 10 with row 6 of 13-tyre-payment-tds-preflight.sql: the same. READ-ONLY. Function
-- fingerprints are the md5 of the repository's definitions. (12-tyre-payments-post-apply.sql's rows 4–6 describe the
-- state before this migration: payments are now deleted by the Owner / Dev — no longer voided —, allocations have a
-- guarded DELETE, and both functions changed.)
--
-- Output: check_no | check_name | expected | actual | status (OK / STOP; INFO = facts to note).
select check_no, check_name, expected, actual,
       case when kind = 'INFO' then 'INFO' when actual = expected then 'OK' else 'STOP' end as status
from (values
  (1, 'CHECK', 'database', 'postgres', current_database()::text),
  (2, 'CHECK', 'columns tds_rate, tds_amount on ops.tyre_payments', 'tds_amount,tds_rate',
      (select string_agg(column_name::text, ',' order by column_name) from information_schema.columns where table_schema = 'ops' and table_name = 'tyre_payments' and column_name in ('tds_rate', 'tds_amount'))),
  (3, 'CHECK', 'TDS = round(settled × % / 100, 2) (constraint)', 'present',
      case when exists (select 1 from pg_constraint where conrelid = to_regclass('ops.tyre_payments') and conname = 'tyre_payments_tds_check') then 'present' else 'missing' end),
  (4, 'CHECK', 'payment modes: Cash, UPI, NEFT, RTGS, IMPS, Cheque — never Credit', 'IMPS, no Credit',
      (select case when pg_get_constraintdef(oid) ilike '%credit%' then 'Credit allowed' when pg_get_constraintdef(oid) like '%IMPS%' then 'IMPS, no Credit' else 'missing IMPS' end
       from pg_constraint where conrelid = to_regclass('ops.tyre_payments') and conname = 'tyre_payments_mode_check')),
  (5, 'CHECK', 'tyre_payment_guard() = repository', '9b2c495de2c1cde5d3578b5ba57a6b81', (select md5(prosrc) from pg_proc where oid = to_regprocedure('private.tyre_payment_guard()'))),
  (6, 'CHECK', 'tyre_payment_check() = repository', 'b3395b1d209dc30a7abdeddafbde3a10', (select md5(prosrc) from pg_proc where oid = to_regprocedure('private.tyre_payment_check()'))),
  (7, 'CHECK', 'tyre_allocation_delete_guard() = repository', 'ae128ed73e3506107078cae30bdfbb16', (select md5(prosrc) from pg_proc where oid = to_regprocedure('private.tyre_allocation_delete_guard()'))),
  (8, 'CHECK', 'DELETE: payments Owner / Dev only (policy); allocations with their policy and the edit guard', 'payments:owner/dev; allocations:policy+guard',
      (select 'payments:' || case when exists (select 1 from pg_policies where schemaname = 'ops' and tablename = 'tyre_payments' and cmd = 'DELETE'
                                                  and qual ~ 'private\.can\(''tyres''::text, ''delete''::text\)' and qual !~ '''(edit|create)''::text') then 'owner/dev' else 'UNEXPECTED' end
              || '; allocations:' || case when exists (select 1 from pg_policies where schemaname = 'ops' and tablename = 'tyre_payment_allocations' and cmd = 'DELETE')
                        and exists (select 1 from pg_trigger where tgname = 'tyre_payment_allocations_edit_delete') then 'policy+guard' else 'UNGUARDED' end)),
  (9, 'CHECK', 'no TDS invented: payments with TDS right after the migration', '0',
      (select count(*)::text from ops.tyre_payments where tds_rate is not null or tds_amount <> 0)),
  (10, 'INFO', 'payments · allocations · Σ amount (= pre-flight row 6)', '',
      (select (select count(*) from ops.tyre_payments)::text || ' · ' || (select count(*) from ops.tyre_payment_allocations)::text || ' · '
              || (select coalesce(sum(amount), 0) from ops.tyre_payments)::text)),
  (11, 'CHECK', 'no voided / void_reason columns (deletion replaces voiding)', 'none',
      coalesce((select string_agg(column_name::text, ',') from information_schema.columns where table_schema = 'ops' and table_name = 'tyre_payments' and column_name in ('voided', 'void_reason')), 'none')),
  (12, 'CHECK', 'a payment''s allocations go with it (foreign key on delete cascade)', 'cascade',
      (select case confdeltype when 'c' then 'cascade' else confdeltype::text end from pg_constraint where conrelid = to_regclass('ops.tyre_payment_allocations') and conname = 'tyre_payment_allocations_payment_id_fkey')),
  (13, 'CHECK', 'one reference per payment (unique index over every payment)', 'unique, all rows',
      (select case when i.indisunique and i.indpred is null then 'unique, all rows' when i.indpred is not null then 'partial' else 'not unique' end
       from pg_index i where i.indexrelid = to_regclass('ops.tyre_payments_utr_key')))
) as t(check_no, kind, check_name, expected, actual)
order by check_no;
