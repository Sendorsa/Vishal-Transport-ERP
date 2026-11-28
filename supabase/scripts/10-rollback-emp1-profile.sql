-- DESTRUCTIVE — ROLLBACK of 20261129000100_emp1_profile.sql (the EMP 1 profile). NOT read-only. Prepared for review — run
-- only on the owner's decision, in the Supabase Dashboard → SQL Editor (role postgres), as one script.
--
-- Only while NO account has the EMP1 role (active, invited or deactivated): it stops, changing nothing, otherwise — Dev
-- gives each such account another role first (Settings → User accounts; audited). Audit events recorded by an EMP 1
-- account stay as they are (append-only); they keep their role label.
--
-- What it does, in one transaction (all or nothing):
--   1. removes EMP1's permission rows (core.role_permissions — configuration, not business data);
--   2. puts private.is_owner_or_dev(), private.customer_in_scope() (20261105000000 / 20261111000200) and
--      private.changed_modules() (20261128000000) back to their exact previous text, and the seven policies back to
--      their 20261128000000 definitions; drops private.expense_section_ok / expense_event_ok;
--   3. checks the result (fingerprints, no EMP1 row, no Expense permission row left).
-- The role value EMP1 stays in public.erp_role, unused (PostgreSQL can't drop an enum value without recreating the type).
--
-- ORDER: roll back 20261129000200 (the Owner's Expense access — 11-rollback-owner-expense.sql) first if it is applied;
-- this script stops until then. Deploy the app version without EMP 1 first. Before rolling back Expense (08), run this.

begin;

do $$
begin
  if to_regprocedure('private.expense_section_ok(text)') is null then
    raise exception 'EMP 1 rollback stopped: 20261129000100 is not applied (or already rolled back). Nothing was changed.';
  end if;
  if exists (select 1 from core.role_permissions where role = 'OWNER' and permission like 'expenses%') then
    raise exception 'EMP 1 rollback stopped: the Owner''s Expense access (20261129000200) is applied — run 11-rollback-owner-expense.sql first. Nothing was changed.';
  end if;
  if exists (select 1 from public.profiles where role::text = 'EMP1') then
    raise exception 'EMP 1 rollback stopped: % account(s) have the EMP1 role — give them another role first. Nothing was changed.',
      (select count(*) from public.profiles where role::text = 'EMP1');
  end if;
end $$;

/* 1. permissions */
delete from core.role_permissions where role::text = 'EMP1';

/* 2. functions and policies as before */
create or replace function private.is_owner_or_dev() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(private.erp_role() in ('OWNER', 'DEV', 'EMPLOYEE'), false)
$$;

create or replace function private.customer_in_scope(p_customer_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  select case
    when private.erp_role() in ('OWNER', 'DEV', 'EMPLOYEE', 'ADBLUE') then true
    when private.erp_role() = 'TATA_ADBLUE' then exists (
      select 1 from core.profile_customer_access a where a.profile_id = private.current_profile_id() and a.customer_id = p_customer_id)
    else false
  end
$$;

create or replace function private.changed_modules(p_since timestamptz) returns setof text
language sql stable security definer set search_path = '' as $$
  select distinct e.module from audit.events e
  where e.at > p_since - interval '2 minutes'
    and (e.module <> 'Expense' or private.can('expenses', 'view'))
    and ((select private.can('audit', 'view')) or private.can(private.module_resource(e.module), 'view')
         or (e.module in ('Customers', 'Vehicles', 'Month Lock') and (select private.can('diesel', 'view'))))
$$;

drop policy "Read Expense entries" on expense.entries;
create policy "Read Expense entries" on expense.entries for select to authenticated using ((select private.can('expenses', 'view')));
drop policy "Add Expense entries" on expense.entries;
create policy "Add Expense entries" on expense.entries for insert to authenticated
  with check ((select private.can('expenses', 'create')) and private.expense_month_open(section, date) and private.month_open(date));
drop policy "Edit Expense entries" on expense.entries;
create policy "Edit Expense entries" on expense.entries for update to authenticated
  using ((select private.can('expenses', 'edit')) and private.expense_month_open(section, date) and private.month_open(date))
  with check (private.expense_month_open(section, date) and private.month_open(date));
drop policy "Delete Expense entries" on expense.entries;
create policy "Delete Expense entries" on expense.entries for delete to authenticated
  using ((select private.can('expenses', 'delete')) and private.expense_month_open(section, date) and private.month_open(date));
drop policy "Read Expense month locks" on expense.month_locks;
create policy "Read Expense month locks" on expense.month_locks for select to authenticated using ((select private.can('expenses', 'view')));
drop policy "Lock Expense months" on expense.month_locks;
create policy "Lock Expense months" on expense.month_locks for insert to authenticated
  with check ((select private.can('expenses', 'edit')) and month <= to_char(private.today_ist(), 'YYYY-MM')
    and locked_by_role = (select private.erp_role()) and locked_by = (select private.current_profile_id()));
drop policy "Read audit events" on audit.events;
create policy "Read audit events" on audit.events for select to authenticated
  using ((select private.can('audit', 'view')) and (module <> 'Expense' or (select private.can('expenses', 'view'))));

drop function private.expense_section_ok(text);
drop function private.expense_event_ok(text);

/* 3. the result */
do $$
begin
  if (select md5(prosrc) from pg_proc where oid = to_regprocedure('private.is_owner_or_dev()')) <> '2ae8b908a6835eccdea3838947a01343'
     or (select md5(prosrc) from pg_proc where oid = to_regprocedure('private.customer_in_scope(text)')) <> '6a70cc900fbf77214f1e5691faf6b429'
     or (select md5(prosrc) from pg_proc where oid = to_regprocedure('private.changed_modules(timestamptz)')) <> '03f296af048852e632816e7acf6907dc' then
    raise exception 'EMP 1 rollback check failed: a function differs from its previous text. Nothing was changed.';
  end if;
  if exists (select 1 from core.role_permissions where role::text = 'EMP1' or permission like 'expenses%') then
    raise exception 'EMP 1 rollback check failed: an EMP1 or Expense permission row remains. Nothing was changed.';
  end if;
end $$;

commit;
