-- Owner's instruction, 28 Nov 2026: the OWNER gets full access to Expense — every section (Road Tax, Insurance, Fitness,
-- Fines, Broker Charges): view, add, edit, delete (and, as the month-lock authority, locking a section-month). Run ONCE
-- in the Supabase Dashboard → SQL Editor as one script, AFTER 20261129000100_emp1_profile.sql. It opens its own
-- transaction: any error — or a guard below — changes nothing. NOT YET APPLIED to any project.
-- Verify afterwards: supabase/scripts/production-readonly/32-owner-expense-post-apply.sql — every CHECK row OK.
--
-- One permission row: ('OWNER', 'expenses:*') — mirrors MAP.OWNER (BUSINESS_ACCESS) + UNRELEASED_ROLES in
-- src/lib/permissions.ts. Nothing else is needed: every Expense policy, guard and audit rule already decides by
-- private.can('expenses', …) (delete: the Owner and Dev only, 20261116000000), the section rules of
-- 20261129000100 restrict EMP1 only, month locks need private.can_set_month_lock() (the Owner and Dev), and imports
-- stay Dev's (private.is_dev()). Unchanged: the EMPLOYEE (no Expense row), EMP1 (expenses:view / edit), the AdBlue
-- profiles, DEV ('*'), every policy, function, grant, account and business row.
--
-- Rollback: supabase/scripts/11-rollback-owner-expense.sql (removes the row; Expense records and audit events stay).

begin;

do $$
begin
  if to_regprocedure('private.expense_section_ok(text)') is null or not exists (select 1 from core.role_permissions where role::text = 'EMP1') then
    raise exception 'Owner Expense access stopped: apply 20261129000100_emp1_profile.sql first. Nothing was changed.';
  end if;
  if exists (select 1 from core.role_permissions where role = 'OWNER' and permission like 'expenses%') then
    raise exception 'Owner Expense access stopped: it is already applied. Nothing was changed.';
  end if;
  if exists (select 1 from core.role_permissions where permission like 'expenses%' and not (role::text = 'EMP1' and permission in ('expenses:view', 'expenses:edit'))) then
    raise exception 'Owner Expense access stopped: an unexpected Expense permission row exists — not the reviewed state. Nothing was changed.';
  end if;
end $$;

insert into core.role_permissions (role, permission) values ('OWNER', 'expenses:*');

do $$
begin
  -- Exactly: OWNER expenses:*, EMP1 expenses:view / expenses:edit — no other role (DEV holds '*').
  if (select string_agg(role::text || ' ' || permission, ', ' order by role::text, permission) from core.role_permissions where permission like 'expenses%')
     is distinct from 'EMP1 expenses:edit, EMP1 expenses:view, OWNER expenses:*' then
    raise exception 'Owner Expense access check failed: the Expense permission rows are not the reviewed ones. Nothing was changed.';
  end if;
end $$;

commit;
