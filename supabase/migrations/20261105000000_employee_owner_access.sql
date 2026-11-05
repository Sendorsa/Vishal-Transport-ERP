-- Owner's instruction, 5 Nov 2026: the EMPLOYEE has the OWNER's access and Owner-level controls, except Settings.
-- Mirrors src/lib/permissions.ts: MAP.EMPLOYEE = BUSINESS_ACCESS without settings:*, and hasOwnerAuthority (Owner, Dev,
-- Employee). Settings stay refused by the existing `settings` policies (companies, app settings, payment categories);
-- accounts and system stay Dev-only (private.can, private.is_dev).
--
-- Authorization only. No table, column, row of business data or existing permission row is changed or removed:
-- permission rows are added (existing EMPLOYEE rows stay; they are covered by the new wildcards) and one function
-- definition is replaced.

insert into core.role_permissions (role, permission) values
  ('EMPLOYEE', 'dashboard:*'), ('EMPLOYEE', 'finance:*'), ('EMPLOYEE', 'customers:*'), ('EMPLOYEE', 'vehicles:*'),
  ('EMPLOYEE', 'trips:*'), ('EMPLOYEE', 'diesel:*'), ('EMPLOYEE', 'invoices:*'), ('EMPLOYEE', 'payments:*'),
  ('EMPLOYEE', 'reports:*'), ('EMPLOYEE', 'audit:*')
on conflict do nothing;

-- Owner-level authority (month locks and locked months, deletion review, Restore / Push Back, go-live openings).
-- The name is kept so every policy and trigger that uses it follows without being rewritten.
create or replace function private.is_owner_or_dev() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(private.erp_role() in ('OWNER', 'DEV', 'EMPLOYEE'), false)
$$;
