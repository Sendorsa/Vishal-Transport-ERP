-- Post-apply check for 20261118000100_adblue_direct_purchase_payments.sql. Run right after the migration's COMMIT in the
-- Supabase SQL Editor of project dqnoducqiootfvkzskhu: every CHECK row OK (row 9 only right after the migration — before
-- anyone records a direct purchase on credit). Compare the INFO rows 10 and 11 with rows 6 and 7 of
-- 17-adblue-direct-payments-preflight.sql: the same. READ-ONLY. Function fingerprints are the md5 of the repository's
-- definitions. (16-adblue-payments-post-apply.sql's rows 6–7 describe the state before this migration: both functions
-- changed here; its other rows still hold.) Run 10-adblue-vendors-post-apply.sql too — unchanged: every row OK.
--
-- Output: check_no | check_name | expected | actual | status (OK / STOP; INFO = facts to note).
select check_no, check_name, expected, actual,
       case when kind = 'INFO' then 'INFO' when actual = expected then 'OK' else 'STOP' end as status
from (values
  (1, 'CHECK', 'database', 'postgres', current_database()::text),
  (2, 'CHECK', 'payment mode CREDIT (direct purchase on the vendor''s account)', 'present',
      case when exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'fuel' and t.typname = 'adblue_payment_mode' and e.enumlabel = 'CREDIT') then 'present' else 'missing' end),
  (3, 'CHECK', 'an allocation points at exactly one: bulk purchase or direct purchase', 'entry_id, nullable purchase_id, one-of check',
      case when exists (select 1 from information_schema.columns where table_schema = 'fuel' and table_name = 'adblue_payment_allocations' and column_name = 'entry_id')
                and exists (select 1 from information_schema.columns where table_schema = 'fuel' and table_name = 'adblue_payment_allocations' and column_name = 'purchase_id' and is_nullable = 'YES')
                and exists (select 1 from pg_constraint where conrelid = to_regclass('fuel.adblue_payment_allocations') and conname = 'adblue_payment_allocations_target_check') then 'entry_id, nullable purchase_id, one-of check' else 'UNEXPECTED' end),
  (4, 'CHECK', 'a direct purchase with payments is never deleted (entry_id foreign key, no cascade)', 'no action',
      (select case confdeltype when 'a' then 'no action' else confdeltype::text end from pg_constraint where conrelid = to_regclass('fuel.adblue_payment_allocations') and contype = 'f' and confrelid = to_regclass('fuel.adblue_entries'))),
  (5, 'CHECK', 'adblue_payment_check() = repository', '716d7d6ed51325ddd05b199d079e65d6', (select md5(prosrc) from pg_proc where oid = to_regprocedure('private.adblue_payment_check()'))),
  (6, 'CHECK', 'adblue_allocation_delete_guard() = repository', 'dec5a7e6b00379bf35c42e48c63b95a9', (select md5(prosrc) from pg_proc where oid = to_regprocedure('private.adblue_allocation_delete_guard()'))),
  (7, 'CHECK', 'a direct purchase''s edit is checked against what was paid (trigger)', 'present',
      case when exists (select 1 from pg_trigger where tgname = 'adblue_entries_paid_check' and tgrelid = to_regclass('fuel.adblue_entries')) then 'present' else 'missing' end),
  (8, 'CHECK', 'RLS: allocation insert / delete and payment delete cover direct purchases (entry_id)', '3 of 3',
      (select count(*) filter (where coalesce(qual, '') || coalesce(with_check, '') ~ 'entry_id')::text || ' of ' || count(*)::text from pg_policies
       where schemaname = 'fuel' and policyname in ('Delete AdBlue payments', 'Add AdBlue payment allocations', 'Remove AdBlue payment allocations'))),
  (9, 'CHECK', 'no direct purchase on credit, no direct allocation right after the migration', '0 · 0',
      (select (select count(*) from fuel.adblue_entries where payment_mode::text = 'CREDIT')::text || ' · ' || (select count(*) from fuel.adblue_payment_allocations where entry_id is not null)::text)),
  (10, 'INFO', 'direct purchases · Σ their amount (= pre-flight row 6)', '',
      (select count(*)::text || ' · ' || coalesce(sum(amount), 0)::text from fuel.adblue_entries where source = 'DIRECT')),
  (11, 'INFO', 'payments · allocations · Σ allocated (= pre-flight row 7)', '',
      (select (select count(*) from fuel.adblue_payments)::text || ' · ' || (select count(*) from fuel.adblue_payment_allocations)::text || ' · ' || (select coalesce(sum(amount), 0) from fuel.adblue_payment_allocations)::text))
) as t(check_no, kind, check_name, expected, actual)
order by check_no;
