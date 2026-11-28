-- DESTRUCTIVE — ROLLBACK of 20261129000200_owner_expense_access.sql (the Owner's Expense access). NOT read-only. Prepared
-- for review — run only on the owner's decision, in the Supabase Dashboard → SQL Editor (role postgres), as one script.
--
-- Removes one configuration row, ('OWNER', 'expenses:*'): the Owner can no longer read or change Expense. Nothing else
-- changes — every Expense record, broker, month lock and audit event (also those the Owner recorded) stays, and Dev and
-- EMP 1 keep their access. One transaction (all or nothing).
--
-- ORDER: deploy the app version without the Owner's Expense access first (otherwise the Owner sees empty Expense pages
-- and every save is refused). Before rolling back EMP 1 (10) or Expense (08), run this.

begin;

do $$
begin
  if not exists (select 1 from core.role_permissions where role = 'OWNER' and permission = 'expenses:*') then
    raise exception 'Owner Expense rollback stopped: 20261129000200 is not applied (or already rolled back). Nothing was changed.';
  end if;
end $$;

delete from core.role_permissions where role = 'OWNER' and permission = 'expenses:*';

do $$
begin
  if exists (select 1 from core.role_permissions where role = 'OWNER' and permission like 'expenses%') then
    raise exception 'Owner Expense rollback check failed: an Owner Expense row remains. Nothing was changed.';
  end if;
end $$;

commit;
