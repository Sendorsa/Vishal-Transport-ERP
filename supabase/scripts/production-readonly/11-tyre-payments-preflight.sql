-- Pre-flight for 20261117000100_tyre_payments.sql. Run BEFORE the migration in the Supabase SQL Editor of project
-- dqnoducqiootfvkzskhu: every CHECK row OK. READ-ONLY: a single SELECT over the system catalogs and the tyre tables
-- (counts and sums only). Note the INFO rows: 12-tyre-payments-post-apply.sql shows the same figures after the migration
-- (nothing existing changes). Before 20261117000000_tyre_data.sql it fails (ops.tyre_invoices does not exist): apply that
-- migration first.
--
-- Output: check_no | check_name | expected | actual | status (OK / STOP; INFO = facts to note).
select check_no, check_name, expected, actual,
       case when kind = 'INFO' then 'INFO' when actual = expected then 'OK' else 'STOP' end as status
from (values
  (1, 'CHECK', 'database', 'postgres', current_database()::text),
  (2, 'CHECK', 'Tyre Data (20261117000000) applied: its three tables and line guard', 'present',
      case when to_regclass('ops.tyre_masters') is not null and to_regclass('ops.tyre_invoices') is not null and to_regclass('ops.tyre_invoice_items') is not null
                and to_regprocedure('private.tyre_item_delete_guard()') is not null then 'present' else 'missing' end),
  (3, 'CHECK', 'tyre payments not applied yet (tables, functions)', 'absent',
      case when to_regclass('ops.tyre_payments') is null and to_regclass('ops.tyre_payment_allocations') is null
                and to_regprocedure('private.tyre_payment_check()') is null and to_regprocedure('private.tyre_payment_guard()') is null then 'absent' else 'present' end),
  (4, 'CHECK', 'helpers the migration uses', 'present',
      case when to_regprocedure('private.new_id(text)') is not null and to_regprocedure('private.refuse_future_date()') is not null
                and to_regprocedure('private.touch_updated_at()') is not null and to_regprocedure('private.require_audit_event()') is not null
                and to_regprocedure('private.require_parent_audit_event()') is not null and to_regprocedure('private.month_open(date)') is not null
                and to_regprocedure('private.can(text,text)') is not null and to_regprocedure('private.erp_role()') is not null
                and to_regclass('core.companies') is not null then 'present' else 'missing' end),
  (5, 'CHECK', 'no trigger of that name on the tyre invoice tables yet', '0',
      (select count(*)::text from pg_trigger where tgname in ('tyre_invoices_paid_check', 'tyre_invoice_items_paid_check'))),
  (6, 'CHECK', 'Tyre permission rows (Dev holds *) — the payments use the same resource', 'EMPLOYEE:tyres:*,OWNER:tyres:*',
      (select string_agg(role::text || ':' || permission, ',' order by role::text) from core.role_permissions where permission like 'tyres%')),
  (7, 'INFO', 'tyre invoices · lines · Σ total (unchanged by the migration)', '',
      (select (select count(*) from ops.tyre_invoices)::text || ' · ' || (select count(*) from ops.tyre_invoice_items)::text || ' · ' || (select coalesce(sum(total_value), 0) from ops.tyre_invoice_items)::text)),
  (8, 'INFO', 'tyre suppliers with invoices', '',
      (select count(distinct supplier_id)::text from ops.tyre_invoices)),
  (9, 'INFO', 'invoices whose payment type says paid (not Credit / blank) — they stay unpaid: no payment is invented', '',
      (select count(*)::text from ops.tyre_invoices where btrim(payment_mode) <> '' and lower(btrim(payment_mode)) <> 'credit'))
) as t(check_no, kind, check_name, expected, actual)
order by check_no;
