-- Post-apply check for 20261118000000_adblue_supplier_payments.sql. Run right after the migration's COMMIT in the
-- Supabase SQL Editor of project dqnoducqiootfvkzskhu: every CHECK row OK (rows 3 and 10 only right after the migration —
-- before anyone records GST or a payment). Compare the INFO row 11 with row 6 of 15-adblue-payments-preflight.sql: the
-- same. READ-ONLY. Function fingerprints are the md5 of the repository's definitions. Run 10-adblue-vendors-post-apply.sql
-- too: its row 10 now lists the two new tables (payments Owner / Dev; allocations inside an audited edit).
--
-- Output: check_no | check_name | expected | actual | status (OK / STOP; INFO = facts to note).
select check_no, check_name, expected, actual,
       case when kind = 'INFO' then 'INFO' when actual = expected then 'OK' else 'STOP' end as status
from (values
  (1, 'CHECK', 'database', 'postgres', current_database()::text),
  (2, 'CHECK', 'tables fuel.adblue_payments, fuel.adblue_payment_allocations; row level security on both', 'on,on',
      (select string_agg(case when c.relrowsecurity then 'on' else 'OFF' end, ',' order by c.relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'fuel' and c.relname in ('adblue_payments', 'adblue_payment_allocations'))),
  (3, 'CHECK', 'GST columns added; every existing purchase at 0 % (its value unchanged)', 'gst_amount,gst_rate · 0',
      (select string_agg(column_name::text, ',' order by column_name) from information_schema.columns where table_schema = 'fuel' and table_name = 'adblue_purchases' and column_name in ('gst_rate', 'gst_amount'))
      || ' · ' || (select count(*)::text from fuel.adblue_purchases where gst_rate <> 0 or gst_amount <> 0)),
  (4, 'CHECK', 'TDS = round(settled × % / 100, 2) (constraint); modes never Credit', 'present, no Credit',
      case when exists (select 1 from pg_constraint where conrelid = to_regclass('fuel.adblue_payments') and conname = 'adblue_payments_tds_check')
                and not exists (select 1 from pg_constraint where conrelid = to_regclass('fuel.adblue_payments') and pg_get_constraintdef(oid) ilike '%credit%') then 'present, no Credit' else 'UNEXPECTED' end),
  (5, 'CHECK', 'adblue_payment_guard() = repository', 'efcfde4fd60d093d65e2d6a5340fb53e', (select md5(prosrc) from pg_proc where oid = to_regprocedure('private.adblue_payment_guard()'))),
  (6, 'CHECK', 'adblue_payment_check() = repository', '3a04b998cab14df56c723f152c0f4732', (select md5(prosrc) from pg_proc where oid = to_regprocedure('private.adblue_payment_check()'))),
  (7, 'CHECK', 'adblue_allocation_delete_guard() = repository', 'c4c5cc887b4b9e306fcf0aefe13113a5', (select md5(prosrc) from pg_proc where oid = to_regprocedure('private.adblue_allocation_delete_guard()'))),
  (8, 'CHECK', 'DELETE: payments Owner / Dev only (policy); allocations with their policy and the edit guard', 'payments:owner/dev; allocations:policy+guard',
      (select 'payments:' || case when exists (select 1 from pg_policies where schemaname = 'fuel' and tablename = 'adblue_payments' and cmd = 'DELETE'
                                                  and qual ~ 'private\.can\(''adblue''::text, ''delete''::text\)' and qual !~ '''(edit|create)''::text') then 'owner/dev' else 'UNEXPECTED' end
              || '; allocations:' || case when exists (select 1 from pg_policies where schemaname = 'fuel' and tablename = 'adblue_payment_allocations' and cmd = 'DELETE')
                        and exists (select 1 from pg_trigger where tgname = 'adblue_payment_allocations_edit_delete') then 'policy+guard' else 'UNGUARDED' end)),
  (9, 'CHECK', 'reading and writing payments needs the Owner, Dev or Employee (never the AdBlue profiles)', '5 of 5',
      (select count(*) filter (where coalesce(qual, '') || coalesce(with_check, '') ~ 'is_owner_or_dev')::text || ' of ' || count(*)::text from pg_policies
       where schemaname = 'fuel' and tablename in ('adblue_payments', 'adblue_payment_allocations') and cmd in ('SELECT', 'INSERT', 'UPDATE')
         )),
  (10, 'CHECK', 'no payment invented right after the migration (payments · allocations)', '0 · 0',
      (select (select count(*) from fuel.adblue_payments)::text || ' · ' || (select count(*) from fuel.adblue_payment_allocations)::text)),
  (11, 'INFO', 'purchases · opening-stock records · Σ total_cost · Σ total_litres (= pre-flight row 6)', '',
      (select count(*)::text || ' · ' || count(*) filter (where opening)::text || ' · ' || coalesce(sum(total_cost), 0)::text || ' · ' || coalesce(sum(total_litres), 0)::text from fuel.adblue_purchases)),
  (12, 'CHECK', 'a payment''s allocations go with it; a purchase with allocations is never deleted', 'cascade · no action',
      (select (select case confdeltype when 'c' then 'cascade' else confdeltype::text end from pg_constraint where conrelid = to_regclass('fuel.adblue_payment_allocations') and conname = 'adblue_payment_allocations_payment_id_fkey')
              || ' · ' || (select case confdeltype when 'a' then 'no action' else confdeltype::text end from pg_constraint where conrelid = to_regclass('fuel.adblue_payment_allocations') and conname = 'adblue_payment_allocations_purchase_id_fkey'))),
  (13, 'CHECK', 'one reference per payment (unique index over every payment)', 'unique, all rows',
      (select case when i.indisunique and i.indpred is null then 'unique, all rows' when i.indpred is not null then 'partial' else 'not unique' end
       from pg_index i where i.indexrelid = to_regclass('fuel.adblue_payments_utr_key')))
) as t(check_no, kind, check_name, expected, actual)
order by check_no;
