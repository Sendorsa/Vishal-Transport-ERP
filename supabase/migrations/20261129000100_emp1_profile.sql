-- Owner's instruction, 28 Nov 2026: the ERP profile "EMP 1" (role EMP1). Script B of two — run AFTER
-- 20261129000000_erp_role_emp1.sql has committed. Run ONCE in the Supabase Dashboard → SQL Editor as one script. It opens
-- its own transaction: any error — or a guard below — changes nothing. NOT YET APPLIED to any project.
-- Read-only 30-emp1-preflight.sql first (every CHECK row OK), then this, then 31-emp1-post-apply.sql.
--
-- EMP 1 = exactly the EMPLOYEE for every existing module, plus Expense → Road Tax, Fitness, Fines and Broker Charges:
-- view and edit only. Never Insurance (not even its audit events), never a new or deleted Expense record, never a broker
-- added, never an Expense month locked, never an import or import rollback. Mirrors src/lib/permissions.ts (MAP.EMP1,
-- UNRELEASED_ROLES, HIDDEN_EXPENSE_SECTIONS, hasOwnerAuthority, canLockExpenseMonths).
--
-- What it changes (the EMPLOYEE and every other role are unchanged — checked at the end):
--   1. core.role_permissions: EMP1 gets a copy of every EMPLOYEE row (as it is now; the EMPLOYEE holds no Expense row)
--      plus expenses:view and expenses:edit. private.can already refuses delete to everyone but the Owner and Dev.
--   2. private.is_owner_or_dev() (the Owner-level controls the Employee holds) and private.customer_in_scope() (every
--      customer) include EMP1 — as for the Employee.
--   3. New private.expense_section_ok(section) and private.expense_event_ok(record_type): false only for EMP1 and
--      Insurance (records) / anything but the four sections' record types (audit events: no Insurance, no Expense month,
--      no import batch). Text arguments — they don't depend on the expense schema's types.
--   4. Policies: expense.entries (read / add / edit / delete) and expense.month_locks (read) also require the section;
--      "Lock Expense months" also requires private.can_set_month_lock() (the Owner / Dev — Dev, as only Dev holds
--      expenses today); audit.events "Read audit events" and private.changed_modules filter Expense events by
--      expense_event_ok. The vehicle lines and the audit reviews follow (their policies read the filtered tables).
-- No table, row of business data, grant, account or other role's permission is touched.
--
-- Rollback: supabase/scripts/10-rollback-emp1-profile.sql (only while no account has the EMP1 role); the enum value
-- stays, unused.

begin;

do $$
begin
  if not exists (select 1 from pg_enum where enumtypid = 'public.erp_role'::regtype and enumlabel = 'EMP1') then
    raise exception 'EMP 1 migration stopped: run and commit 20261129000000_erp_role_emp1.sql first. Nothing was changed.';
  end if;
  if to_regnamespace('expense') is null or to_regprocedure('private.can_set_month_lock()') is null
     or to_regprocedure('private.customer_in_scope(text)') is null or to_regprocedure('private.is_owner_or_dev()') is null
     or to_regprocedure('private.changed_modules(timestamptz)') is null then
    raise exception 'EMP 1 migration stopped: apply every migration up to 20261128000000_expense_schema.sql first. Nothing was changed.';
  end if;
  if exists (select 1 from core.role_permissions where role::text = 'EMP1') or to_regprocedure('private.expense_section_ok(text)') is not null
     or to_regprocedure('private.expense_event_ok(text)') is not null then
    raise exception 'EMP 1 migration stopped: it is already applied (fully or partly). Nothing was changed.';
  end if;
  if exists (select 1 from core.role_permissions where role::text = 'EMPLOYEE' and permission like 'expenses%') then
    raise exception 'EMP 1 migration stopped: the EMPLOYEE holds an Expense permission — not the reviewed state. Nothing was changed.';
  end if;
  -- The three functions replaced below must be exactly the repository's current text.
  if (select md5(prosrc) from pg_proc where oid = to_regprocedure('private.is_owner_or_dev()')) <> '2ae8b908a6835eccdea3838947a01343'
     or (select md5(prosrc) from pg_proc where oid = to_regprocedure('private.customer_in_scope(text)')) <> '6a70cc900fbf77214f1e5691faf6b429'
     or (select md5(prosrc) from pg_proc where oid = to_regprocedure('private.changed_modules(timestamptz)')) <> '03f296af048852e632816e7acf6907dc' then
    raise exception 'EMP 1 migration stopped: is_owner_or_dev, customer_in_scope or changed_modules differs from the repository. Nothing was changed.';
  end if;
end $$;

/* ------------------------------------------------------------------ 1. permissions: the EMPLOYEE's, plus Expense view / edit */

insert into core.role_permissions (role, permission)
select 'EMP1'::public.erp_role, permission from core.role_permissions where role = 'EMPLOYEE'
union all
select 'EMP1'::public.erp_role, p from unnest(array['expenses:view', 'expenses:edit']) p;

/* ------------------------------------------------------------------ 2. the Employee's Owner-level controls and customer scope */

create or replace function private.is_owner_or_dev() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(private.erp_role() in ('OWNER', 'DEV', 'EMPLOYEE', 'EMP1'), false)
$$;

create or replace function private.customer_in_scope(p_customer_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  select case
    when private.erp_role() in ('OWNER', 'DEV', 'EMPLOYEE', 'EMP1', 'ADBLUE') then true
    when private.erp_role() = 'TATA_ADBLUE' then exists (
      select 1 from core.profile_customer_access a where a.profile_id = private.current_profile_id() and a.customer_id = p_customer_id)
    else false
  end
$$;

/* ------------------------------------------------------------------ 3. the Expense sections EMP 1 may use */

-- Records: every section except Insurance for EMP1; every section for every other role (then private.can decides).
create function private.expense_section_ok(p_section text) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.erp_role() is distinct from 'EMP1' or p_section <> 'INSURANCE'
$$;

-- Audit events of module Expense: for EMP1 only the four sections' record types (= EXPENSE_EVENT_SECTION in
-- src/lib/api/index.ts without Insurance) — never Insurance, an Expense month or an import batch.
create function private.expense_event_ok(p_record_type text) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.erp_role() is distinct from 'EMP1'
    or p_record_type in ('Road tax', 'Fitness', 'Fine', 'Broker charge', 'Broker payment', 'Broker opening balance', 'Broker')
$$;

revoke all on function private.expense_section_ok(text), private.expense_event_ok(text) from public, anon;
grant execute on function private.expense_section_ok(text), private.expense_event_ok(text) to authenticated, service_role;

/* ------------------------------------------------------------------ 4. policies */

drop policy "Read Expense entries" on expense.entries;
create policy "Read Expense entries" on expense.entries for select to authenticated
  using ((select private.can('expenses', 'view')) and private.expense_section_ok(section::text));
drop policy "Add Expense entries" on expense.entries;
create policy "Add Expense entries" on expense.entries for insert to authenticated
  with check ((select private.can('expenses', 'create')) and private.expense_section_ok(section::text) and private.expense_month_open(section, date) and private.month_open(date));
drop policy "Edit Expense entries" on expense.entries;
create policy "Edit Expense entries" on expense.entries for update to authenticated
  using ((select private.can('expenses', 'edit')) and private.expense_section_ok(section::text) and private.expense_month_open(section, date) and private.month_open(date))
  with check (private.expense_section_ok(section::text) and private.expense_month_open(section, date) and private.month_open(date));
drop policy "Delete Expense entries" on expense.entries;
create policy "Delete Expense entries" on expense.entries for delete to authenticated
  using ((select private.can('expenses', 'delete')) and private.expense_section_ok(section::text) and private.expense_month_open(section, date) and private.month_open(date));

drop policy "Read Expense month locks" on expense.month_locks;
create policy "Read Expense month locks" on expense.month_locks for select to authenticated
  using ((select private.can('expenses', 'view')) and private.expense_section_ok(section::text));
drop policy "Lock Expense months" on expense.month_locks;
create policy "Lock Expense months" on expense.month_locks for insert to authenticated
  with check ((select private.can('expenses', 'edit')) and (select private.can_set_month_lock()) and month <= to_char(private.today_ist(), 'YYYY-MM')
    and locked_by_role = (select private.erp_role()) and locked_by = (select private.current_profile_id()));

drop policy "Read audit events" on audit.events;
create policy "Read audit events" on audit.events for select to authenticated
  using ((select private.can('audit', 'view')) and (module <> 'Expense' or ((select private.can('expenses', 'view')) and private.expense_event_ok(record_type))));

-- Security definer (bypasses RLS), so it filters Expense itself: polling never tells a role about an Expense event it
-- can't read.
create or replace function private.changed_modules(p_since timestamptz) returns setof text
language sql stable security definer set search_path = '' as $$
  select distinct e.module from audit.events e
  where e.at > p_since - interval '2 minutes'
    and (e.module <> 'Expense' or (private.can('expenses', 'view') and private.expense_event_ok(e.record_type)))
    and ((select private.can('audit', 'view')) or private.can(private.module_resource(e.module), 'view')
         or (e.module in ('Customers', 'Vehicles', 'Month Lock') and (select private.can('diesel', 'view'))))
$$;

/* ------------------------------------------------------------------ 5. the result */

do $$
begin
  -- EMP1 = the EMPLOYEE's rows + expenses:view / expenses:edit, nothing else.
  if exists (select permission from core.role_permissions where role::text = 'EMPLOYEE' except select permission from core.role_permissions where role::text = 'EMP1')
     or exists (select permission from core.role_permissions where role::text = 'EMP1' except
                (select permission from core.role_permissions where role::text = 'EMPLOYEE' union select unnest(array['expenses:view', 'expenses:edit']))) then
    raise exception 'EMP 1 migration check failed: its permission rows are not the EMPLOYEE''s plus expenses:view / expenses:edit. Nothing was changed.';
  end if;
  if exists (select 1 from core.role_permissions where permission like 'expenses%' and role::text <> 'EMP1') then
    raise exception 'EMP 1 migration check failed: another role holds an Expense permission row. Nothing was changed.';
  end if;
end $$;

commit;
