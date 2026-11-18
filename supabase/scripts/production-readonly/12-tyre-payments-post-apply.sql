-- Post-apply check for 20261117000100_tyre_payments.sql. Run right after the migration's COMMIT in the Supabase SQL
-- Editor of project dqnoducqiootfvkzskhu: every CHECK row OK (row 12 only right after the migration — before anyone
-- records a payment). Compare the INFO row 13 with row 7 of 11-tyre-payments-preflight.sql: the same. READ-ONLY: a
-- single SELECT over the system catalogs and the tyre tables (counts and sums only). Function fingerprints are the md5
-- of the repository's definitions. Before the migration it fails (ops.tyre_payments does not exist) — expected.
--
-- Output: check_no | check_name | expected | actual | status (OK / STOP; INFO = facts to note).
select check_no, check_name, expected, actual,
       case when kind = 'INFO' then 'INFO' when actual = expected then 'OK' else 'STOP' end as status
from (values
  (1, 'CHECK', 'database', 'postgres', current_database()::text),
  (2, 'CHECK', 'tables ops.tyre_payments, ops.tyre_payment_allocations', 'present',
      case when to_regclass('ops.tyre_payments') is not null and to_regclass('ops.tyre_payment_allocations') is not null then 'present' else 'missing' end),
  (3, 'CHECK', 'row level security on both', 'on,on',
      (select string_agg(case when c.relrowsecurity then 'on' else 'off' end, ',' order by c.relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'ops' and c.relname in ('tyre_payments', 'tyre_payment_allocations'))),
  (4, 'CHECK', 'signed-in users: no DELETE on either table, no UPDATE on allocations (never deleted, insert-only)', 'none',
      (select coalesce(string_agg(table_name::text || ':' || privilege_type::text, ',' order by table_name, privilege_type), 'none') from information_schema.role_table_grants
       where grantee in ('authenticated', 'anon', 'public') and table_schema = 'ops' and ((table_name = 'tyre_payments' and privilege_type = 'DELETE')
         or (table_name = 'tyre_payment_allocations' and privilege_type in ('DELETE', 'UPDATE'))))),
  (5, 'CHECK', 'tyre_payment_guard() = repository', '3bdb150abf1fdeea8690c9401d9d86e8',
      (select md5(prosrc) from pg_proc where oid = to_regprocedure('private.tyre_payment_guard()'))),
  (6, 'CHECK', 'tyre_payment_check() = repository', '09ed7bc59db24ee2b0c0e48b459fa220',
      (select md5(prosrc) from pg_proc where oid = to_regprocedure('private.tyre_payment_check()'))),
  (7, 'CHECK', 'triggers (paid ≤ total, same supplier, immutability, no future date, audit presence)', '10',
      (select count(*)::text from pg_trigger where not tgisinternal and tgname in ('tyre_payments_guard', 'tyre_payments_no_future', 'tyre_payments_touch',
         'tyre_payments_allocated_check', 'tyre_payment_allocations_allocated_check', 'tyre_invoices_paid_check', 'tyre_invoice_items_paid_check',
         'tyre_payments_require_audit', 'tyre_payment_allocations_require_audit', 'tyre_invoice_items_has_lines'))),
  (8, 'CHECK', 'one UTR on one live payment (unique index)', 'present',
      case when to_regclass('ops.tyre_payments_utr_key') is not null then 'present' else 'missing' end),
  (9, 'CHECK', 'payment modes: Cash, UPI, NEFT, RTGS, Cheque — never Credit', 'no Credit',
      (select case when bool_or(pg_get_constraintdef(oid) ilike '%credit%') then 'Credit allowed' when bool_or(pg_get_constraintdef(oid) like '%RTGS%') then 'no Credit' else 'missing' end
       from pg_constraint where conrelid = to_regclass('ops.tyre_payments') and contype = 'c')),
  (10, 'CHECK', 'policies: read / add / change payments; read / add allocations', '5',
      (select count(*)::text from pg_policies where schemaname = 'ops' and tablename in ('tyre_payments', 'tyre_payment_allocations'))),
  (11, 'CHECK', 'audit module → permission (unchanged)', 'tyres', (select private.module_resource('Tyre'))),
  (12, 'CHECK', 'no payment invented: payments · allocations right after the migration', '0 · 0',
      (select (select count(*) from ops.tyre_payments)::text || ' · ' || (select count(*) from ops.tyre_payment_allocations)::text)),
  (13, 'INFO', 'tyre invoices · lines · Σ total (= pre-flight row 7)', '',
      (select (select count(*) from ops.tyre_invoices)::text || ' · ' || (select count(*) from ops.tyre_invoice_items)::text || ' · ' || (select coalesce(sum(total_value), 0) from ops.tyre_invoice_items)::text))
) as t(check_no, kind, check_name, expected, actual)
order by check_no;
