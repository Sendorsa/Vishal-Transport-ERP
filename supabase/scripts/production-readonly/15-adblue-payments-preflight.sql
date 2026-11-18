-- Pre-flight for 20261118000000_adblue_supplier_payments.sql. Run BEFORE the migration in the Supabase SQL Editor of
-- project dqnoducqiootfvkzskhu: every CHECK row OK. READ-ONLY: a single SELECT over the system catalogs and
-- fuel.adblue_purchases (counts and sums only). Note the INFO row: 16-adblue-payments-post-apply.sql shows the same
-- figures after the migration (no purchase changes; every purchase stays outstanding — no payment is invented).
--
-- Output: check_no | check_name | expected | actual | status (OK / STOP; INFO = facts to note).
select check_no, check_name, expected, actual,
       case when kind = 'INFO' then 'INFO' when actual = expected then 'OK' else 'STOP' end as status
from (values
  (1, 'CHECK', 'database', 'postgres', current_database()::text),
  (2, 'CHECK', 'AdBlue vendors (20261116000000) applied', 'present',
      case when to_regclass('fuel.adblue_vendors') is not null and to_regprocedure('private.edit_delete_guard()') is not null
                and exists (select 1 from information_schema.columns where table_schema = 'fuel' and table_name = 'adblue_purchases' and column_name = 'vendor_id') then 'present' else 'missing' end),
  (3, 'CHECK', 'this migration not applied yet (payment tables, GST columns)', 'absent',
      case when to_regclass('fuel.adblue_payments') is null and to_regclass('fuel.adblue_payment_allocations') is null and to_regprocedure('private.adblue_payment_check()') is null
                and not exists (select 1 from information_schema.columns where table_schema = 'fuel' and table_name = 'adblue_purchases' and column_name in ('gst_rate', 'gst_amount')) then 'absent' else 'present' end),
  (4, 'CHECK', 'helpers the migration uses', 'present',
      case when to_regprocedure('private.can(text,text)') is not null and to_regprocedure('private.is_owner_or_dev()') is not null and to_regprocedure('private.month_open(date)') is not null
                and to_regprocedure('private.refuse_future_date()') is not null and to_regprocedure('private.require_audit_event()') is not null
                and to_regprocedure('private.require_parent_audit_event()') is not null and to_regprocedure('private.touch_updated_at()') is not null then 'present' else 'missing' end),
  (5, 'CHECK', 'every purchase that is not opening stock has its vendor (it becomes payable to that vendor)', '0',
      (select count(*)::text from fuel.adblue_purchases where not opening and vendor_id is null)),
  (6, 'INFO', 'purchases · opening-stock records · Σ total_cost · Σ total_litres (unchanged by the migration)', '',
      (select count(*)::text || ' · ' || count(*) filter (where opening)::text || ' · ' || coalesce(sum(total_cost), 0)::text || ' · ' || coalesce(sum(total_litres), 0)::text from fuel.adblue_purchases))
) as t(check_no, kind, check_name, expected, actual)
order by check_no;
