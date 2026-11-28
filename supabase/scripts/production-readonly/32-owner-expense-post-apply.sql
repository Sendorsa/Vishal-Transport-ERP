-- READ-ONLY. Run after 20261129000200_owner_expense_access.sql (the Owner's Expense access). Every CHECK row must say OK.
-- A single SELECT over the system catalogs and counts — it changes nothing and reads no business data.
select check_no, check_name, expected, actual,
       case when kind = 'INFO' then 'INFO' when actual = expected then 'OK' else 'STOP' end as status
from (values
  (1, 'CHECK', 'Expense permission rows of every role (DEV holds *)', 'EMP1 expenses:edit, EMP1 expenses:view, OWNER expenses:*',
      (select string_agg(role::text || ' ' || permission, ', ' order by role::text, permission) from core.role_permissions where permission like 'expenses%')),
  (2, 'CHECK', 'the EMPLOYEE and the AdBlue profiles: no Expense row, no wildcard', '0',
      (select count(*)::text from core.role_permissions where role::text in ('EMPLOYEE', 'TATA_ADBLUE', 'ADBLUE') and (permission like 'expenses%' or permission = '*'))),
  (3, 'CHECK', 'EMP1 section rules in place (expense_section_ok, expense_event_ok)', '2',
      (select count(*)::text from pg_proc where oid in (to_regprocedure('private.expense_section_ok(text)'), to_regprocedure('private.expense_event_ok(text)')))),
  (4, 'CHECK', 'delete: the Owner and Dev only (private.can)', 'yes',
      (select case when prosrc ~ 'action <> ''delete'' or coalesce\(private\.erp_role\(\) in \(''OWNER'', ''DEV''\)' then 'yes' else 'no' end from pg_proc where oid = to_regprocedure('private.can(text,text)'))),
  (5, 'CHECK', 'locking Expense months needs can_set_month_lock (the Owner / Dev); imports need is_dev', 'yes · yes',
      (select case when with_check ~ 'can_set_month_lock' then 'yes' else 'no' end from pg_policies where schemaname = 'expense' and tablename = 'month_locks' and cmd = 'INSERT')
      || ' · ' || (select case when bool_and(coalesce(qual, with_check) ~ 'is_dev') then 'yes' else 'no' end from pg_policies where schemaname = 'expense' and tablename in ('import_batches', 'import_items'))),
  (6, 'INFO', 'accounts by role (no account is changed by this migration)', '',
      coalesce((select string_agg(role::text || ' ×' || n, ', ' order by role::text) from (select role, count(*) n from public.profiles group by 1) a), 'none'))
) as t(check_no, kind, check_name, expected, actual)
order by check_no;
