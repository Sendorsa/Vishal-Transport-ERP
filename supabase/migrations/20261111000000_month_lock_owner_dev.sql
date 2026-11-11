-- Owner's instruction, 11 Nov 2026: locking or unlocking a month is the Owner's and Dev's only — the Employee may no
-- longer do it (it still sees each month's lock state, and still enters / edits data in open months).
-- Mirrors src/lib/permissions.ts: canSetMonthLock (Owner, Dev). private.is_owner_or_dev() keeps the Employee for the
-- other Owner-level controls (deletion review, Restore / Push Back, go-live openings), so month locking gets its own check.
--
-- Authorization only. No table, column or row is changed: one function is added and three policies are recreated with
-- the same text, except the month-lock checks. Apply in the Supabase SQL Editor after review (one script = one transaction).

create function private.can_set_month_lock() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(private.erp_role() in ('OWNER', 'DEV'), false)
$$;
revoke all on function private.can_set_month_lock() from public, anon;
grant execute on function private.can_set_month_lock() to authenticated, service_role;

-- The rows: only the Owner and Dev insert or update a month lock, recorded as the role that really did it.
drop policy "Owner and Dev lock months" on core.month_locks;
drop policy "Owner and Dev unlock months" on core.month_locks;
create policy "Owner and Dev lock months" on core.month_locks for insert to authenticated
  with check ((select private.can_set_month_lock()) and changed_by_role = (select private.erp_role()));
create policy "Owner and Dev unlock months" on core.month_locks for update to authenticated
  using ((select private.can_set_month_lock())) with check (changed_by_role = (select private.erp_role()));

-- The audit trail: MONTH_LOCKED / MONTH_UNLOCKED events by the Owner and Dev only (the version from 20261103000000,
-- unchanged except the last line).
drop policy "Write own audit events" on audit.events;
create policy "Write own audit events" on audit.events for insert to authenticated
  with check (
    actor_kind = 'SESSION'
    and actor_user_id = (select private.current_profile_id())
    and actor_role = (select private.erp_role())
    and module <> 'Accounts' -- account events are written only by the account functions
    and action <> 'DATA_RESET'
    and (action <> 'DELETED' or private.can(private.module_resource(module), 'delete'))
    and (restores_event_id is null or (select private.is_owner_or_dev()))
    and (action not in ('MONTH_LOCKED', 'MONTH_UNLOCKED') or (select private.can_set_month_lock()))
  );

