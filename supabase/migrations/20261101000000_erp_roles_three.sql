-- Diesel database, phase 1 — design approved by the owner on 1 Nov 2026 (D-1 … D-18). See docs/SUPABASE_DIESEL_DATABASE_SCHEMA.md (decision D-2).
--
-- Only three ERP roles exist since 31 Oct 2026 (owner's instruction): OWNER, DEV, EMPLOYEE. The applied migration
-- 20261028000000_erp_accounts.sql still lists ACCOUNTANT and OPS_MANAGER. Postgres can't drop an enum value, so the
-- type is recreated. Refuses to run (and changes nothing) if any account still holds a removed role.

do $$
begin
  if exists (select 1 from public.profiles where role::text in ('ACCOUNTANT', 'OPS_MANAGER')) then
    raise exception 'An ERP account still has the removed role ACCOUNTANT or OPS_MANAGER. Give it OWNER, DEV or EMPLOYEE first.';
  end if;
end $$;

alter type public.erp_role rename to erp_role_with_legacy;
create type public.erp_role as enum ('OWNER', 'DEV', 'EMPLOYEE');
alter table public.profiles alter column role type public.erp_role using role::text::public.erp_role;
drop type public.erp_role_with_legacy;

comment on type public.erp_role is 'ERP roles: OWNER (everything), DEV (everything except Owner-only actions), EMPLOYEE (fuel entries and trips). Mirrors Role in src/lib/types.ts.';
