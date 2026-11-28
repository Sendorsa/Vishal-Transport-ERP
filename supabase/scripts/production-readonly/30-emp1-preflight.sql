-- READ-ONLY. Run before 20261129000100_emp1_profile.sql (EMP 1), after 20261129000000_erp_role_emp1.sql has committed.
-- Every CHECK row must say OK; any STOP = don't apply. A single SELECT over the system catalogs and counts — it changes
-- nothing and reads no personal data.
select check_no, check_name, expected, actual,
       case when kind = 'INFO' then 'INFO' when actual = expected then 'OK' else 'STOP' end as status
from (values
  (1, 'CHECK', 'erp_role values (script A committed)', 'OWNER,DEV,EMPLOYEE,EMP1,TATA_ADBLUE,ADBLUE',
      (select string_agg(e.enumlabel, ',' order by e.enumsortorder) from pg_enum e where e.enumtypid = to_regtype('public.erp_role'))),
  (2, 'CHECK', 'Expense migration 20261128000000 applied; prerequisite functions present', 'present',
      case when to_regnamespace('expense') is not null and to_regprocedure('private.can_set_month_lock()') is not null
             and to_regprocedure('private.customer_in_scope(text)') is not null and to_regprocedure('private.is_owner_or_dev()') is not null
             and to_regprocedure('private.changed_modules(timestamptz)') is not null then 'present' else 'missing' end),
  (3, 'CHECK', '20261129000100 not yet applied', 'not applied',
      case when to_regprocedure('private.expense_section_ok(text)') is null and to_regprocedure('private.expense_event_ok(text)') is null
             and not exists (select 1 from core.role_permissions where role::text = 'EMP1') then 'not applied' else 'applied (fully or partly)' end),
  (4, 'CHECK', 'no role holds an Expense permission row yet', '0', (select count(*)::text from core.role_permissions where permission like 'expenses%')),
  (5, 'CHECK', 'is_owner_or_dev() = the repository text', '2ae8b908a6835eccdea3838947a01343',
      (select md5(prosrc) from pg_proc where oid = to_regprocedure('private.is_owner_or_dev()'))),
  (6, 'CHECK', 'customer_in_scope() = the repository text', '6a70cc900fbf77214f1e5691faf6b429',
      (select md5(prosrc) from pg_proc where oid = to_regprocedure('private.customer_in_scope(text)'))),
  (7, 'CHECK', 'changed_modules() = the Expense migration''s text', '03f296af048852e632816e7acf6907dc',
      (select md5(prosrc) from pg_proc where oid = to_regprocedure('private.changed_modules(timestamptz)'))),
  (8, 'CHECK', 'no account has the EMP1 role yet', '0', (select count(*)::text from public.profiles where role::text = 'EMP1')),
  (9, 'INFO', 'EMPLOYEE permission rows (EMP1 receives a copy)', '',
      (select count(*)::text || ': ' || string_agg(permission, ', ' order by permission) from core.role_permissions where role::text = 'EMPLOYEE')),
  (10, 'INFO', 'accounts by role', '', coalesce((select string_agg(role::text || ' ×' || n, ', ' order by role::text) from (select role, count(*) n from public.profiles group by 1) a), 'none'))
) as t(check_no, kind, check_name, expected, actual)
order by check_no;
