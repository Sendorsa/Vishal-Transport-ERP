-- DESTRUCTIVE — ROLLBACK of 20261129000300_emp1_expense_create.sql (EMP 1 adding Expense records). NOT read-only.
-- Prepared for review — run only on the owner's decision, in the Supabase Dashboard → SQL Editor (role postgres), as
-- one script.
--
-- Removes the configuration row ('EMP1', 'expenses:create') and puts the "Add brokers" policy back to its
-- 20261128000000 definition. EMP 1 keeps view and edit. Every record EMP 1 added stays, with its audit events. One
-- transaction (all or nothing).
--
-- ORDER: deploy the app version without EMP 1's Add first. Before rolling back the Owner's access (11), EMP 1 (10) or
-- Expense (08), run this.

begin;

do $$
begin
  if not exists (select 1 from core.role_permissions where role::text = 'EMP1' and permission = 'expenses:create') then
    raise exception 'EMP 1 add rollback stopped: 20261129000300 is not applied (or already rolled back). Nothing was changed.';
  end if;
end $$;

delete from core.role_permissions where role::text = 'EMP1' and permission = 'expenses:create';

drop policy "Add brokers" on expense.brokers;
create policy "Add brokers" on expense.brokers for insert to authenticated with check ((select private.can('expenses', 'create')));

do $$
begin
  if exists (select 1 from core.role_permissions where role::text = 'EMP1' and permission = 'expenses:create') then
    raise exception 'EMP 1 add rollback check failed: the row remains. Nothing was changed.';
  end if;
end $$;

commit;
