-- DESTRUCTIVE — ROLLBACK of 20261128000000_expense_schema.sql (Phase 2B). NOT read-only. Prepared for review — run only on
-- the owner's decision, in the Supabase Dashboard → SQL Editor, as one script.
--
-- Only while Expense holds NO data and has NO audit history: it stops (and changes nothing) if any expense.* table has a
-- row, or if audit.events holds any event of module 'Expense' — even with all six tables empty (an entry created and
-- deleted leaves its CREATED / DELETED events). Those events are append-only: after a rollback they would stay, and
-- module_resource / the audit policies would no longer hide them, so the Owner and Employee would see Dev-only Expense
-- history. With data or history, a rollback needs the owner's approval and a backup first (02-backup-business-data.sql)
-- — plan §5.5 — and this script must not be edited to skip either check.
--
-- What it does, in one transaction (all or nothing):
--   1. drops the schema expense (its six tables, two types, triggers, policies and grants, and the two functions whose
--      signatures use its types: expense_month_open, expense_lock_message);
--   2. drops the eight trigger functions the migration added in `private` (they don't depend on the schema, so the
--      cascade leaves them behind — and a re-apply would then stop on "already exists");
--   3. puts private.module_resource (20261117000000) and private.changed_modules (20261111000200) back to their exact
--      previous text, and the three audit policies back to their previous definitions;
--   4. checks the result: no function mentions Expense, both functions match the migration's guard fingerprints (so
--      20261128000000 can be applied again unchanged), and the audit policies no longer mention Expense.
-- No audit event is removed (there are none: the script refuses otherwise).
--
-- ORDER: roll back 20261129000100 (EMP 1 — 10-rollback-emp1-profile.sql) first if it is applied: it changes Expense
-- policies and holds Expense permission rows; this script stops until then. Then deploy the app version WITHOUT Expense
-- on the shared database. Afterwards 27-expense-preflight.sql
-- reports every CHECK row OK again.

begin;

do $$
begin
  if to_regnamespace('expense') is null then
    raise exception 'Expense rollback stopped: the expense schema does not exist (not applied, or already rolled back). Nothing was changed.';
  end if;
  if to_regprocedure('private.expense_section_ok(text)') is not null or exists (select 1 from core.role_permissions where permission like 'expenses%') then
    raise exception 'Expense rollback stopped: the EMP 1 profile (20261129000100) is applied — run 10-rollback-emp1-profile.sql first. Nothing was changed.';
  end if;
  if exists (select 1 from expense.entries) or exists (select 1 from expense.entry_vehicles) or exists (select 1 from expense.brokers)
     or exists (select 1 from expense.month_locks) or exists (select 1 from expense.import_batches) or exists (select 1 from expense.import_items) then
    raise exception 'Expense rollback stopped: Expense holds data. A rollback with data needs the owner''s approval and a backup first. Nothing was changed.';
  end if;
  if exists (select 1 from audit.events where module = 'Expense') then
    raise exception 'Expense rollback stopped: the audit trail holds % Expense event(s). They are append-only and would stay; after a rollback the Owner and Employee would see this Dev-only history. A rollback now needs the owner''s approval and a backup first. Nothing was changed.',
      (select count(*) from audit.events where module = 'Expense');
  end if;
end $$;

/* 1. the schema (RESTRICT is not possible for a schema with contents; CASCADE stays inside it and the two functions above) */
drop schema expense cascade;

/* 2. the trigger functions left in private */
drop function private.expense_month_lock_guard();
drop function private.broker_ledger_guard();
drop function private.broker_opening_first();
drop function private.entry_vehicle_count();
drop function private.entry_vehicle_delete_guard();
drop function private.expense_entry_fixed();
drop function private.expense_broker_link();
drop function private.expense_not_future();

/* 3. the previous definitions */
create or replace function private.module_resource(module text) returns text
language sql immutable set search_path = '' as $$
  select case module
    when 'Diesel' then 'diesel' when 'AdBlue' then 'adblue' when 'Diesel Tanker' then 'diesel' when 'Fuel Stations' then 'diesel'
    when 'Payments' then 'payments' when 'Customers' then 'customers' when 'Vehicles' then 'vehicles'
    when 'Drivers' then 'settings' when 'Trips' then 'trips' when 'Invoices' then 'invoices' when 'Settings' then 'settings'
    when 'Tyre' then 'tyres'
    else 'audit' end
$$;

create or replace function private.changed_modules(p_since timestamptz) returns setof text
language sql stable security definer set search_path = '' as $$
  select distinct e.module from audit.events e
  where e.at > p_since - interval '2 minutes'
    and ((select private.can('audit', 'view')) or private.can(private.module_resource(e.module), 'view')
         or (e.module in ('Customers', 'Vehicles', 'Month Lock') and (select private.can('diesel', 'view'))))
$$;

drop policy "Read audit events" on audit.events;
create policy "Read audit events" on audit.events for select to authenticated using ((select private.can('audit', 'view')));
drop policy "Owner and Dev read reviews" on audit.reviews;
create policy "Owner and Dev read reviews" on audit.reviews for select to authenticated using ((select private.can('audit', 'view')));
drop policy "Owner and Dev review deletions" on audit.reviews;
create policy "Owner and Dev review deletions" on audit.reviews for insert to authenticated
  with check ((select private.is_owner_or_dev()) and actor_user_id = (select private.current_profile_id()) and actor_role = (select private.erp_role()));

/* 4. the result */
do $$
begin
  if exists (select 1 from pg_proc where pronamespace = 'private'::regnamespace
             and proname in ('expense_month_open', 'expense_lock_message', 'expense_month_lock_guard', 'broker_ledger_guard', 'broker_opening_first',
                             'entry_vehicle_count', 'entry_vehicle_delete_guard', 'expense_entry_fixed', 'expense_broker_link', 'expense_not_future')) then
    raise exception 'Expense rollback check failed: an Expense function remains. Nothing was changed.';
  end if;
  if (select md5(prosrc) from pg_proc where oid = to_regprocedure('private.module_resource(text)')) <> '51eb49b8bc5d0d6eb710f05644b6fd2b'
     or (select md5(prosrc) from pg_proc where oid = to_regprocedure('private.changed_modules(timestamptz)')) <> 'a99d47f13ad3a729cf7662902f34a91a' then
    raise exception 'Expense rollback check failed: module_resource / changed_modules differ from their previous text. Nothing was changed.';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'audit' and (coalesce(qual, '') ~ 'Expense' or coalesce(with_check, '') ~ 'Expense')) then
    raise exception 'Expense rollback check failed: an audit policy still mentions Expense. Nothing was changed.';
  end if;
end $$;

commit;
