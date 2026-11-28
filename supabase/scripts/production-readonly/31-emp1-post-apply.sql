-- READ-ONLY. Run after 20261129000100_emp1_profile.sql (EMP 1). Every CHECK row must say OK. A single SELECT — changes nothing.
select check_no, check_name, expected, actual,
       case when kind = 'INFO' then 'INFO' when actual = expected then 'OK' else 'STOP' end as status
from (values
  (1, 'CHECK', 'EMP1 = the EMPLOYEE''s permission rows + expenses:view / expenses:edit (rows missing · extra)', '0 · 0',
      (select count(*)::text from (select permission from core.role_permissions where role::text = 'EMPLOYEE' union select unnest(array['expenses:view', 'expenses:edit'])
                                   except select permission from core.role_permissions where role::text = 'EMP1') m) || ' · ' ||
      (select count(*)::text from (select permission from core.role_permissions where role::text = 'EMP1'
                                   except (select permission from core.role_permissions where role::text = 'EMPLOYEE' union select unnest(array['expenses:view', 'expenses:edit']))) x)),
  (2, 'CHECK', 'Expense permission rows of EMP1 and the EMPLOYEE (the Owner''s: 32-owner-expense-post-apply.sql)', 'EMP1 expenses:edit, EMP1 expenses:view',
      (select string_agg(role::text || ' ' || permission, ', ' order by role::text, permission) from core.role_permissions where permission like 'expenses%' and role::text in ('EMP1', 'EMPLOYEE'))),
  (3, 'CHECK', 'is_owner_or_dev and customer_in_scope include EMP1', 'yes,yes',
      (select string_agg(case when prosrc ~ '''EMP1''' then 'yes' else 'no' end, ',' order by proname) from pg_proc
         where oid in (to_regprocedure('private.customer_in_scope(text)'), to_regprocedure('private.is_owner_or_dev()')))),
  (4, 'CHECK', 'expense_section_ok / expense_event_ok present', '2',
      (select count(*)::text from pg_proc where oid in (to_regprocedure('private.expense_section_ok(text)'), to_regprocedure('private.expense_event_ok(text)')))),
  (5, 'CHECK', 'entries policies require the section (read · add · edit · delete)', 'yes,yes,yes,yes',
      (select string_agg(case when coalesce(qual, '') || coalesce(with_check, '') ~ 'expense_section_ok' then 'yes' else 'no' end, ',' order by cmd)
         from pg_policies where schemaname = 'expense' and tablename = 'entries')),
  (6, 'CHECK', 'month locks: read needs the section; locking needs can_set_month_lock', 'yes · yes',
      (select case when qual ~ 'expense_section_ok' then 'yes' else 'no' end from pg_policies where schemaname = 'expense' and tablename = 'month_locks' and cmd = 'SELECT')
      || ' · ' || (select case when with_check ~ 'can_set_month_lock' then 'yes' else 'no' end from pg_policies where schemaname = 'expense' and tablename = 'month_locks' and cmd = 'INSERT')),
  (7, 'CHECK', 'audit read policy and changed_modules filter Expense events by section', 'yes · yes',
      (select case when qual ~ 'expense_event_ok' then 'yes' else 'no' end from pg_policies where schemaname = 'audit' and tablename = 'events' and policyname = 'Read audit events')
      || ' · ' || (select case when prosrc ~ 'expense_event_ok' then 'yes' else 'no' end from pg_proc where oid = to_regprocedure('private.changed_modules(timestamptz)'))),
  (8, 'CHECK', 'new functions: anon can execute · authenticated can execute', '0 · 2',
      (select count(*) filter (where has_function_privilege('anon', p.oid, 'execute'))::text || ' · ' || count(*) filter (where has_function_privilege('authenticated', p.oid, 'execute'))
         from pg_proc p where p.oid in (to_regprocedure('private.expense_section_ok(text)'), to_regprocedure('private.expense_event_ok(text)')))),
  (9, 'INFO', 'accounts by role (no account is changed by this migration)', '',
      coalesce((select string_agg(role::text || ' ×' || n, ', ' order by role::text) from (select role, count(*) n from public.profiles group by 1) a), 'none'))
) as t(check_no, kind, check_name, expected, actual)
order by check_no;
