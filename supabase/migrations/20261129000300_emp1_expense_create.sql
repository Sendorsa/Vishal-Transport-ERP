-- Owner's instruction, 28 Nov 2026: EMP 1 also ADDS Expense records — Road Tax, Fitness, Fines, Broker Charges (never
-- Insurance, never a delete, never a new broker, month lock, import or rollback). Run ONCE in the Supabase Dashboard →
-- SQL Editor as one script, AFTER 20261129000200_owner_expense_access.sql. It opens its own transaction: any error — or
-- a guard below — changes nothing. NOT YET APPLIED to any project.
-- Verify afterwards: supabase/scripts/production-readonly/33-emp1-create-post-apply.sql — every CHECK row OK.
--
-- What it changes (mirrors MAP.EMP1 and canAddBrokers in src/lib/permissions.ts):
--   1. core.role_permissions: ('EMP1', 'expenses:create'). The entry policies already require the section
--      (private.expense_section_ok — no Insurance for EMP1), the section-month lock and the Monthly Sheet Lock
--      (private.month_open — EMP1 follows it as the Employee); vehicle lines follow the entry; delete stays the Owner's
--      and Dev's (private.can); month locks need private.can_set_month_lock(); imports need private.is_dev().
--   2. expense.brokers "Add brokers": with `expenses` create AND the Owner or Dev (private.is_owner() / is_dev()) — so the
--      new row doesn't let EMP1 extend the broker list. The Owner and Dev keep exactly what they had.
-- Unchanged: the EMPLOYEE, the OWNER, DEV, the AdBlue profiles, every other policy, function, grant, account and row.
--
-- Rollback: supabase/scripts/12-rollback-emp1-expense-create.sql (records EMP1 added stay, with their audit events).

begin;

do $$
begin
  if not exists (select 1 from core.role_permissions where role = 'OWNER' and permission = 'expenses:*')
     or to_regprocedure('private.expense_section_ok(text)') is null or to_regprocedure('private.is_owner()') is null or to_regprocedure('private.is_dev()') is null then
    raise exception 'EMP 1 add access stopped: apply 20261129000100 and 20261129000200 first. Nothing was changed.';
  end if;
  if exists (select 1 from core.role_permissions where role::text = 'EMP1' and permission = 'expenses:create') then
    raise exception 'EMP 1 add access stopped: it is already applied. Nothing was changed.';
  end if;
  if (select string_agg(role::text || ' ' || permission, ', ' order by role::text, permission) from core.role_permissions where permission like 'expenses%')
     is distinct from 'EMP1 expenses:edit, EMP1 expenses:view, OWNER expenses:*' then
    raise exception 'EMP 1 add access stopped: the Expense permission rows are not the reviewed ones. Nothing was changed.';
  end if;
end $$;

insert into core.role_permissions (role, permission) values ('EMP1'::public.erp_role, 'expenses:create');

drop policy "Add brokers" on expense.brokers;
create policy "Add brokers" on expense.brokers for insert to authenticated
  with check ((select private.can('expenses', 'create')) and ((select private.is_owner()) or (select private.is_dev())));

do $$
begin
  if (select string_agg(role::text || ' ' || permission, ', ' order by role::text, permission) from core.role_permissions where permission like 'expenses%')
     is distinct from 'EMP1 expenses:create, EMP1 expenses:edit, EMP1 expenses:view, OWNER expenses:*' then
    raise exception 'EMP 1 add access check failed: the Expense permission rows are not the reviewed ones. Nothing was changed.';
  end if;
end $$;

commit;
