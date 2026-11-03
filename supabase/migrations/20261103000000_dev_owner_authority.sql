-- Owner's decision, 3 Nov 2026 (OD-1 in docs/SUPABASE_SHARED_DATA_MIGRATION_PLAN.md):
--   DEV inherits every OWNER business permission — including month lock / unlock, changing a locked month, the
--   deletion review and Restore / Push Back — and alone holds account and system administration.
--   OWNER keeps every business permission and no account / system administration. EMPLOYEE is unchanged.
-- Mirrors src/lib/permissions.ts (MAP, DEV_ONLY, hasOwnerAuthority). Additive: earlier migrations are not edited;
-- the functions and policies they created are replaced here.

/* ------------------------------------------------------------------ permissions: Dev holds "*", the Owner every business resource */
delete from core.role_permissions where role in ('OWNER', 'DEV');
insert into core.role_permissions (role, permission) values
  ('DEV', '*'),
  ('OWNER', 'dashboard:*'), ('OWNER', 'finance:*'), ('OWNER', 'customers:*'), ('OWNER', 'vehicles:*'), ('OWNER', 'trips:*'),
  ('OWNER', 'diesel:*'), ('OWNER', 'invoices:*'), ('OWNER', 'payments:*'), ('OWNER', 'reports:*'), ('OWNER', 'settings:*'),
  ('OWNER', 'audit:*');
-- The Dev-only resources (accounts, system) are never reachable by another role, whatever the table says.
create or replace function private.can(resource text, action text default 'view') returns boolean
language sql stable security definer set search_path = '' as $$
  select (resource not in ('accounts', 'system') or private.erp_role() = 'DEV') and exists (
    select 1 from core.role_permissions rp
    where rp.role = private.erp_role() and rp.permission in ('*', resource || ':*', resource || ':' || action)
  )
$$;

/* ------------------------------------------------------------------ the Monthly Sheet Lock: Owner and Dev may change any month */
create or replace function private.month_open(d date) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_owner_or_dev() or coalesce(
    (select ml.state = 'OPEN' from core.month_locks ml where ml.month = to_char(d, 'YYYY-MM')),
    date_trunc('month', d) >= date_trunc('month', private.today_ist())
  )
$$;

drop policy "Owner locks months" on core.month_locks;
drop policy "Owner unlocks months" on core.month_locks;
-- Recorded as the role that really did it: a Dev lock is never labelled Owner.
create policy "Owner and Dev lock months" on core.month_locks for insert to authenticated
  with check ((select private.is_owner_or_dev()) and changed_by_role = (select private.erp_role()));
create policy "Owner and Dev unlock months" on core.month_locks for update to authenticated
  using ((select private.is_owner_or_dev())) with check (changed_by_role = (select private.erp_role()));

/* ------------------------------------------------------------------ audit: restores and month-lock events by Owner or Dev */
drop policy "Write own audit events" on audit.events; -- the version created by 20261101000700_accounts.sql
create policy "Write own audit events" on audit.events for insert to authenticated
  with check (
    actor_kind = 'SESSION'
    and actor_user_id = (select private.current_profile_id())
    and actor_role = (select private.erp_role())
    and module <> 'Accounts' -- account events are written only by the account functions
    and action <> 'DATA_RESET'
    and (action <> 'DELETED' or private.can(private.module_resource(module), 'delete'))
    and (restores_event_id is null or (select private.is_owner_or_dev()))
    and (action not in ('MONTH_LOCKED', 'MONTH_UNLOCKED') or (select private.is_owner_or_dev()))
  );

drop policy "Owner reviews deletions" on audit.reviews;
create policy "Owner and Dev review deletions" on audit.reviews for insert to authenticated
  with check ((select private.is_owner_or_dev()) and actor_user_id = (select private.current_profile_id()) and actor_role = (select private.erp_role()));

create or replace function private.fuel_station_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.is_tanker_source is distinct from old.is_tanker_source then
    raise exception 'The tanker source can''t be changed.' using errcode = 'check_violation';
  end if;
  if (new.opening_balance, new.opening_balance_date) is distinct from (old.opening_balance, old.opening_balance_date)
     and private.erp_role() is not null then
    if not private.is_owner_or_dev() then
      raise exception 'Only the Owner or Dev can record opening balances.' using errcode = 'insufficient_privilege';
    end if;
    if (old.opening_balance_date is not null and not private.month_open(old.opening_balance_date))
       or (new.opening_balance_date is not null and not private.month_open(new.opening_balance_date)) then
      raise exception 'That month is locked. Only the Owner or Dev can change it.' using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end $$;
