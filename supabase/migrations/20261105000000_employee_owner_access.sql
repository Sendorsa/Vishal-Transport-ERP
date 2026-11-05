-- Owner's instruction, 5 Nov 2026: the EMPLOYEE has the OWNER's access and Owner-level controls, except Settings and
-- except changing data in a locked month (the Employee may still lock and unlock months).
-- Mirrors src/lib/permissions.ts: MAP.EMPLOYEE = BUSINESS_ACCESS without settings:*, hasOwnerAuthority (Owner, Dev,
-- Employee) and canBypassMonthLock (Owner, Dev). Settings stay refused by the existing `settings` policies (companies, app settings, payment categories);
-- accounts and system stay Dev-only (private.can, private.is_dev).
--
-- Authorization only. No table, column, row of business data or existing permission row is changed or removed:
-- permission rows are added (existing EMPLOYEE rows stay; they are covered by the new wildcards) and two function
-- definitions are replaced.

insert into core.role_permissions (role, permission) values
  ('EMPLOYEE', 'dashboard:*'), ('EMPLOYEE', 'finance:*'), ('EMPLOYEE', 'customers:*'), ('EMPLOYEE', 'vehicles:*'),
  ('EMPLOYEE', 'trips:*'), ('EMPLOYEE', 'diesel:*'), ('EMPLOYEE', 'invoices:*'), ('EMPLOYEE', 'payments:*'),
  ('EMPLOYEE', 'reports:*'), ('EMPLOYEE', 'audit:*')
on conflict do nothing;

-- Owner-level authority (month lock / unlock, deletion review, Restore / Push Back, go-live openings).
-- The name is kept so every policy and trigger that uses it follows without being rewritten.
create or replace function private.is_owner_or_dev() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(private.erp_role() in ('OWNER', 'DEV', 'EMPLOYEE'), false)
$$;

-- The Monthly Sheet Lock: only the Owner and Dev change a locked month (canEditMonth). Every lock check — RLS on
-- entries, loads, payments, trips, assignments, and the opening-balance / opening-odometer guards — uses this function,
-- so the Employee is refused there even though it now holds Owner-level authority above.
create or replace function private.month_open(d date) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(private.erp_role() in ('OWNER', 'DEV'), false) or coalesce(
    (select ml.state = 'OPEN' from core.month_locks ml where ml.month = to_char(d, 'YYYY-MM')),
    date_trunc('month', d) >= date_trunc('month', private.today_ist())
  )
$$;
