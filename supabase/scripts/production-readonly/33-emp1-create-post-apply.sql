-- READ-ONLY. Run after 20261129000300_emp1_expense_create.sql (EMP 1 adds Expense records). Every CHECK row must say OK.
-- A single SELECT over the system catalogs and counts — it changes nothing and reads no business data.
select check_no, check_name, expected, actual,
       case when kind = 'INFO' then 'INFO' when actual = expected then 'OK' else 'STOP' end as status
from (values
  (1, 'CHECK', 'Expense permission rows of every role (DEV holds *)', 'EMP1 expenses:create, EMP1 expenses:edit, EMP1 expenses:view, OWNER expenses:*',
      (select string_agg(role::text || ' ' || permission, ', ' order by role::text, permission) from core.role_permissions where permission like 'expenses%')),
  (2, 'CHECK', 'EMP1 has no delete and no wildcard; the EMPLOYEE and AdBlue profiles no Expense row', '0 · 0',
      (select count(*)::text from core.role_permissions where role::text = 'EMP1' and permission in ('expenses:delete', 'expenses:*', '*')) || ' · ' ||
      (select count(*)::text from core.role_permissions where role::text in ('EMPLOYEE', 'TATA_ADBLUE', 'ADBLUE') and (permission like 'expenses%' or permission = '*'))),
  (3, 'CHECK', 'adding Expense entries requires the section (no Insurance for EMP1) and both month locks', 'yes',
      (select case when with_check ~ 'expense_section_ok' and with_check ~ 'expense_month_open' and with_check ~ 'month_open\(date\)' then 'yes' else 'no' end
         from pg_policies where schemaname = 'expense' and tablename = 'entries' and cmd = 'INSERT')),
  (4, 'CHECK', 'adding a broker: the Owner or Dev only', 'yes',
      (select case when with_check ~ 'is_owner' and with_check ~ 'is_dev' then 'yes' else 'no' end from pg_policies where schemaname = 'expense' and tablename = 'brokers' and cmd = 'INSERT')),
  (5, 'CHECK', 'delete: the Owner and Dev only (private.can)', 'yes',
      (select case when prosrc ~ 'action <> ''delete'' or coalesce\(private\.erp_role\(\) in \(''OWNER'', ''DEV''\)' then 'yes' else 'no' end from pg_proc where oid = to_regprocedure('private.can(text,text)'))),
  (6, 'INFO', 'accounts by role (no account is changed by this migration)', '',
      coalesce((select string_agg(role::text || ' ×' || n, ', ' order by role::text) from (select role, count(*) n from public.profiles group by 1) a), 'none'))
) as t(check_no, kind, check_name, expected, actual)
order by check_no;
