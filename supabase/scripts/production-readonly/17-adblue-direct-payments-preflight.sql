-- Pre-flight for 20261118000100_adblue_direct_purchase_payments.sql. Run BEFORE the migration in the Supabase SQL Editor
-- of project dqnoducqiootfvkzskhu: every CHECK row OK. READ-ONLY: a single SELECT over the system catalogs and the AdBlue
-- tables (counts and sums only). Note the INFO rows: 18-adblue-direct-payments-post-apply.sql shows the same figures after
-- the migration (no entry, payment or allocation changes; every existing direct purchase stays paid at purchase).
--
-- Output: check_no | check_name | expected | actual | status (OK / STOP; INFO = facts to note).
select check_no, check_name, expected, actual,
       case when kind = 'INFO' then 'INFO' when actual = expected then 'OK' else 'STOP' end as status
from (values
  (1, 'CHECK', 'database', 'postgres', current_database()::text),
  (2, 'CHECK', 'AdBlue supplier payments (20261118000000) applied', 'present',
      case when to_regclass('fuel.adblue_payments') is not null and to_regclass('fuel.adblue_payment_allocations') is not null and to_regprocedure('private.adblue_payment_check()') is not null then 'present' else 'missing' end),
  (3, 'CHECK', 'this migration not applied yet (entry_id column, CREDIT mode)', 'absent',
      case when not exists (select 1 from information_schema.columns where table_schema = 'fuel' and table_name = 'adblue_payment_allocations' and column_name = 'entry_id')
                and not exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'fuel' and t.typname = 'adblue_payment_mode' and e.enumlabel = 'CREDIT') then 'absent' else 'present' end),
  (4, 'CHECK', 'policies the migration replaces', '3',
      (select count(*)::text from pg_policies where schemaname = 'fuel' and policyname in ('Delete AdBlue payments', 'Add AdBlue payment allocations', 'Remove AdBlue payment allocations'))),
  (5, 'CHECK', 'fuel.adblue_entries.vendor_id present (20261116000000)', 'present',
      case when exists (select 1 from information_schema.columns where table_schema = 'fuel' and table_name = 'adblue_entries' and column_name = 'vendor_id') then 'present' else 'missing' end),
  (6, 'INFO', 'direct purchases · Σ their amount (each stays paid at purchase: never outstanding)', '',
      (select count(*)::text || ' · ' || coalesce(sum(amount), 0)::text from fuel.adblue_entries where source = 'DIRECT')),
  (7, 'INFO', 'payments · allocations · Σ allocated (unchanged by the migration)', '',
      (select (select count(*) from fuel.adblue_payments)::text || ' · ' || (select count(*) from fuel.adblue_payment_allocations)::text || ' · ' || (select coalesce(sum(amount), 0) from fuel.adblue_payment_allocations)::text))
) as t(check_no, kind, check_name, expected, actual)
order by check_no;
