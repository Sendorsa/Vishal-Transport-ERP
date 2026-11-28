-- READ-ONLY. Phase 2A inventory (27 Nov 2026): what is actually on the shared database before the Expense / Drivers
-- design is finalised. Run in the Supabase SQL Editor and send the output. A single SELECT over the system catalogs and
-- counts — it changes nothing and reads no personal data.
select item_no, item, actual
from (values
  (1, 'database · PostgreSQL', current_database()::text || ' · ' || current_setting('server_version')),
  (2, 'schemas present', (select string_agg(nspname, ', ' order by nspname) from pg_namespace where nspname in ('core', 'fuel', 'finance', 'billing', 'ops', 'audit', 'private', 'expense'))),
  (3, 'expense schema exists (must be no before Phase 2B)', case when to_regnamespace('expense') is null then 'no' else 'YES' end),
  -- Migrations since 20261117: their marker objects.
  (10, '20261117000000 tyre data', case when to_regclass('ops.tyre_invoices') is null then 'not applied' else 'applied' end),
  (11, '20261117000100 tyre payments', case when to_regclass('ops.tyre_payments') is null then 'not applied' else 'applied' end),
  (12, '20261117000200 station payment TDS', case when exists (select 1 from pg_constraint where conname = 'payments_station_tds_check') then 'applied' else 'not applied' end),
  (13, '20261117000300 tyre payment TDS edit', case when to_regprocedure('private.tyre_allocation_delete_guard()') is null then 'not applied' else 'applied' end),
  (14, '20261118000000 AdBlue supplier payments', case when to_regclass('fuel.adblue_payments') is null then 'not applied' else 'applied' end),
  (15, '20261118000100 AdBlue direct purchase payments (CREDIT mode)',
      case when to_regtype('fuel.adblue_payment_mode') is null then 'n/a (no type)'
           when exists (select 1 from pg_enum where enumtypid = to_regtype('fuel.adblue_payment_mode') and enumlabel = 'CREDIT') then 'applied' else 'not applied' end),
  (16, '20261118000200 tanker transfer / adjustment edit', case when exists (select 1 from pg_policies where schemaname = 'fuel' and tablename = 'tanker_transfers' and cmd = 'UPDATE') then 'applied' else 'not applied' end),
  (17, '20261121000000 PUC and driver periods', case when to_regclass('core.vehicle_driver_periods') is null then 'not applied' else 'applied' end),
  (18, '20261121000100 DL number unique', case when to_regclass('core.drivers_license_no_key') is null then 'not applied' else 'applied' end),
  (19, '20261122000000 document alert history', case when to_regclass('core.vehicle_document_alerts') is null then 'not applied' else 'applied' end),
  (20, '20261122000100 document alert enforcement', case when exists (select 1 from pg_trigger where tgrelid = 'core.vehicles'::regclass and tgname = 'vehicles_document_alerts') then 'applied' else 'not applied' end),
  (21, '20261127000000 driver master + vehicle company periods', case when to_regclass('core.vehicle_company_periods') is null then 'not applied' else 'applied' end),
  (22, '20261111000000 month lock Owner / Dev only', case when to_regprocedure('private.can_set_month_lock()') is null then 'not applied' else 'applied' end),
  -- Roles and permissions.
  (30, 'role permissions (role: permission list)', (select string_agg(role::text || ': ' || perms, ' | ' order by role::text) from (select role, string_agg(permission, ',' order by permission) perms from core.role_permissions group by role) p)),
  (31, 'permission rows for expenses (must be none — Dev only)', (select count(*)::text from core.role_permissions where permission like 'expenses%')),
  (32, 'accounts by role and status', coalesce((select string_agg(role::text || ' ' || status::text || ' ×' || n, ', ' order by role::text, status::text) from (select role, status, count(*) n from public.profiles group by 1, 2) a), 'none')),
  (33, 'module_resource: Expense · Drivers', private.module_resource('Expense') || ' · ' || private.module_resource('Drivers')),
  -- Master data the Expense design references.
  (40, 'companies', (select string_agg(code, ', ' order by code) from core.companies)),
  (41, 'customers · vehicles · drivers', (select count(*)::text from core.customers) || ' · ' || (select count(*)::text from core.vehicles) || ' · ' || (select count(*)::text from core.drivers)),
  (42, 'vehicles by company', coalesce((select string_agg(company_code || ' ×' || n, ', ' order by company_code) from (select company_code, count(*) n from core.vehicles group by 1) v), 'none')),
  (43, 'vehicle assignments: total · open', (select count(*)::text || ' · ' || count(*) filter (where end_date is null) from core.vehicle_assignments)),
  (44, 'drivers with DL number · DL expiry · phone',
      (select count(*) filter (where btrim(license_no) <> '')::text || ' · ' || count(*) filter (where license_valid_till is not null) || ' · ' || count(*) filter (where btrim(phone) <> '') from core.drivers)),
  (45, 'vehicles with a default driver', (select count(*)::text from core.vehicles where default_driver_id is not null)),
  (46, 'payment categories ROAD_TAX / INSURANCE used by vouchers', (select count(*)::text from finance.payments where category_code in ('ROAD_TAX', 'INSURANCE'))),
  (47, 'Monthly Sheet Lock rows', (select count(*)::text from core.month_locks)),
  (48, 'audit events: total · module Expense', (select count(*)::text from audit.events) || ' · ' || (select count(*)::text from audit.events where module = 'Expense'))
) as t(item_no, item, actual)
order by item_no;
