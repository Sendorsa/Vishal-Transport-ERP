-- READ-ONLY business-data snapshot, to run BEFORE and AFTER applying 20261105000000_employee_owner_access.sql.
-- A single SELECT: no INSERT / UPDATE / DELETE / TRUNCATE / DDL, no temporary objects, no function with side effects.
-- Safe to run in the Supabase SQL Editor of project dqnoducqiootfvkzskhu (check the URL first).
-- Prerequisite: 02-prerequisites-fingerprint.sql reports MISSING 0 / DIFFERENT 0 (every table below then exists).
--
-- Output: one row per metric — section | item | metric | value — in a fixed order. Export it (CSV) before and after
-- and diff the two files. Counts, sums, date ranges and md5 fingerprints only: no email, name, phone, address, GSTIN,
-- note, logo or snapshot content is shown. Run both snapshots from the SQL Editor (same session time zone), because
-- the fingerprints read timestamps as text.
--
-- Expected difference after the target migration (it only adds EMPLOYEE permission rows and replaces two functions):
--   1 Configuration · core.role_permissions — rows, EMPLOYEE count / list and fingerprint change (up to +10 rows:
--   dashboard, finance, customers, vehicles, trips, diesel, invoices, payments, reports, audit :*).
--   Everything else must be identical, unless someone used the ERP between the two snapshots (then audit.events moves).
--
-- Sections
--   1 Configuration     profiles (by role / status), role permissions, companies, app settings, vehicle types,
--                       payment categories, month locks, the dv_tanker system station
--   2 Master data       customers (+ status periods, pricing, route rates), drivers, vehicles (+ status periods,
--                       assignments), fuel stations (excluding dv_tanker), tankers
--   3 Fuel              diesel entries, tanker loads / transfers / adjustments, net tanker stock, AdBlue purchases /
--                       entries, net AdBlue stock
--   4 Finance & billing payments, payment allocations, trips, invoices, invoice lines, invoice-line trips
--   5 Audit             audit events (by module, by action, time range), audit reviews
--   6 Fingerprints      md5 of every row of every table (ordered by primary key): any changed, added or removed row
--                       changes it. public.profiles is fingerprinted without email / full name.
--   7 Coverage          base tables in the ERP schemas that this snapshot does not know (must be "(none)")
with snapshot (section, item, ord, metric, value) as (

  /* ---------------------------------------------------------------- 1 Configuration */
  select '1 Configuration', 'public.profiles', 1, 'rows', count(*)::text from public.profiles
  union all
  select '1 Configuration', 'public.profiles', 10 + r.i * 10 + s.j, 'role ' || r.v || ' / ' || s.v,
         (select count(*) from public.profiles p where p.role = r.v and p.status = s.v)::text
  from unnest(enum_range(null::public.erp_role)) with ordinality r(v, i)
  cross join unnest(enum_range(null::public.account_status)) with ordinality s(v, j)
  union all
  select '1 Configuration', 'public.profiles', 90, 'linked to a sign-in (user_id set)', count(user_id)::text from public.profiles

  union all
  select '1 Configuration', 'core.role_permissions', 1, 'rows', count(*)::text from core.role_permissions
  union all
  select '1 Configuration', 'core.role_permissions', 10 + r.i, 'role ' || r.v || ' permissions',
         coalesce((select string_agg(rp.permission, ', ' order by rp.permission collate "C") from core.role_permissions rp where rp.role = r.v), '(none)')
  from unnest(enum_range(null::public.erp_role)) with ordinality r(v, i)
  union all
  select '1 Configuration', 'core.role_permissions', 20 + r.i, 'role ' || r.v || ' count',
         (select count(*) from core.role_permissions rp where rp.role = r.v)::text
  from unnest(enum_range(null::public.erp_role)) with ordinality r(v, i)

  union all
  select '1 Configuration', 'core.companies', 1, 'rows', count(*)::text from core.companies
  union all
  select '1 Configuration', 'core.companies', 2, 'codes', coalesce(string_agg(code, ', ' order by code collate "C"), '(none)') from core.companies
  union all
  select '1 Configuration', 'core.companies', 3, 'primary company', coalesce(string_agg(code, ', ' order by code collate "C") filter (where is_primary), '(none)') from core.companies

  union all
  select '1 Configuration', 'core.app_settings', 1, 'rows', count(*)::text from core.app_settings
  union all
  select '1 Configuration', 'core.app_settings', 2, 'default_tax_rate / tds_rate / sac_code',
         coalesce(string_agg(concat_ws(' / ', default_tax_rate, tds_rate, sac_code), '; ' order by id), '(none)') from core.app_settings

  union all
  select '1 Configuration', 'core.vehicle_types', 1, 'rows', count(*)::text from core.vehicle_types
  union all
  select '1 Configuration', 'core.vehicle_types', 2, 'codes', coalesce(string_agg(code, ', ' order by code collate "C"), '(none)') from core.vehicle_types

  union all
  select '1 Configuration', 'finance.payment_categories', 1, 'rows', count(*)::text from finance.payment_categories
  union all
  select '1 Configuration', 'finance.payment_categories', 2, 'active', count(*) filter (where active)::text from finance.payment_categories
  union all
  select '1 Configuration', 'finance.payment_categories', 3, 'codes', coalesce(string_agg(code, ', ' order by code collate "C"), '(none)') from finance.payment_categories

  union all
  select '1 Configuration', 'core.month_locks', 1, 'rows', count(*)::text from core.month_locks
  union all
  select '1 Configuration', 'core.month_locks', 2, 'month = state', coalesce(string_agg(month || ' = ' || state, ', ' order by month collate "C"), '(none)') from core.month_locks

  union all
  select '1 Configuration', 'fuel.fuel_stations dv_tanker', 1, 'present', (count(*) = 1)::text from fuel.fuel_stations where id = 'dv_tanker'
  union all
  select '1 Configuration', 'fuel.fuel_stations dv_tanker', 2, 'name / status / is_tanker_source / opening_balance',
         coalesce(string_agg(concat_ws(' / ', name, status, is_tanker_source, coalesce(opening_balance::text, 'null')), '; '), '(missing)')
  from fuel.fuel_stations where id = 'dv_tanker'
  union all
  select '1 Configuration', 'fuel.fuel_stations dv_tanker', 3, 'tanker sources other than dv_tanker', count(*)::text
  from fuel.fuel_stations where is_tanker_source and id <> 'dv_tanker'

  /* ---------------------------------------------------------------- 2 Master data */
  union all
  select '2 Master data', 'core.customers', 1, 'rows', count(*)::text from core.customers
  union all
  select '2 Master data', 'core.customers', 10 + s.i, 'status ' || s.v, (select count(*) from core.customers c where c.status = s.v)::text
  from unnest(enum_range(null::core.entity_status)) with ordinality s(v, i)
  union all
  select '2 Master data', 'core.customers', 20, 'by company', coalesce((select string_agg(k || ' = ' || n, ', ' order by k collate "C") from (select company_code as k, count(*) as n from core.customers group by 1) x), '(none)')
  union all
  select '2 Master data', 'core.customer_status_periods', 1, 'rows', count(*)::text from core.customer_status_periods
  union all
  select '2 Master data', 'core.customer_status_periods', 2, 'open (end_date null)', count(*) filter (where end_date is null)::text from core.customer_status_periods
  union all
  select '2 Master data', 'core.customer_pricing', 1, 'rows', count(*)::text from core.customer_pricing
  union all
  select '2 Master data', 'core.customer_route_rates', 1, 'rows', count(*)::text from core.customer_route_rates

  union all
  select '2 Master data', 'core.drivers', 1, 'rows', count(*)::text from core.drivers
  union all
  select '2 Master data', 'core.drivers', 10 + s.i, 'status ' || s.v, (select count(*) from core.drivers d where d.status = s.v)::text
  from unnest(enum_range(null::core.entity_status)) with ordinality s(v, i)

  union all
  select '2 Master data', 'core.vehicles', 1, 'rows', count(*)::text from core.vehicles
  union all
  select '2 Master data', 'core.vehicles', 10 + s.i, 'status ' || s.v, (select count(*) from core.vehicles v where v.status = s.v)::text
  from unnest(enum_range(null::core.vehicle_status)) with ordinality s(v, i)
  union all
  select '2 Master data', 'core.vehicles', 20 + f.i, 'fuel ' || f.v, (select count(*) from core.vehicles v where v.fuel_type = f.v)::text
  from unnest(enum_range(null::core.fuel_type)) with ordinality f(v, i)
  union all
  select '2 Master data', 'core.vehicles', 30 + o.i, 'ownership ' || o.v, (select count(*) from core.vehicles v where v.ownership = o.v)::text
  from unnest(enum_range(null::core.ownership)) with ordinality o(v, i)
  union all
  select '2 Master data', 'core.vehicles', 40, 'with opening odometer', count(*) filter (where opening_odometer_km is not null)::text from core.vehicles
  union all
  select '2 Master data', 'core.vehicles', 41, 'with an assigned customer (cache)', count(assigned_customer_id)::text from core.vehicles
  union all
  select '2 Master data', 'core.vehicle_status_periods', 1, 'rows', count(*)::text from core.vehicle_status_periods
  union all
  select '2 Master data', 'core.vehicle_status_periods', 2, 'open (end_date null)', count(*) filter (where end_date is null)::text from core.vehicle_status_periods
  union all
  select '2 Master data', 'core.vehicle_assignments', 1, 'rows', count(*)::text from core.vehicle_assignments
  union all
  select '2 Master data', 'core.vehicle_assignments', 10 + s.i, 'status ' || s.v, (select count(*) from core.vehicle_assignments a where a.status = s.v)::text
  from unnest(enum_range(null::core.assignment_status)) with ordinality s(v, i)
  union all
  select '2 Master data', 'core.vehicle_assignments', 20, 'open (end_date null)', count(*) filter (where end_date is null)::text from core.vehicle_assignments
  union all
  select '2 Master data', 'core.vehicle_assignments', 21, 'spare (no customer)', count(*) filter (where customer_id is null)::text from core.vehicle_assignments

  union all
  select '2 Master data', 'fuel.fuel_stations (pumps)', 1, 'rows', count(*)::text from fuel.fuel_stations where not is_tanker_source
  union all
  select '2 Master data', 'fuel.fuel_stations (pumps)', 10 + s.i, 'status ' || s.v,
         (select count(*) from fuel.fuel_stations fs where not fs.is_tanker_source and fs.status = s.v)::text
  from unnest(enum_range(null::core.entity_status)) with ordinality s(v, i)
  union all
  select '2 Master data', 'fuel.fuel_stations (pumps)', 20, 'with opening balance', count(opening_balance)::text from fuel.fuel_stations where not is_tanker_source
  union all
  select '2 Master data', 'fuel.fuel_stations (pumps)', 21, 'Σ opening_balance (₹, + = we owe)', coalesce(sum(opening_balance), 0)::text from fuel.fuel_stations where not is_tanker_source

  union all
  select '2 Master data', 'fuel.tankers', 1, 'rows', count(*)::text from fuel.tankers
  union all
  select '2 Master data', 'fuel.tankers', 10 + s.i, 'status ' || s.v, (select count(*) from fuel.tankers t where t.status = s.v)::text
  from unnest(enum_range(null::core.entity_status)) with ordinality s(v, i)
  union all
  select '2 Master data', 'fuel.tankers', 20, 'ids', coalesce(string_agg(id, ', ' order by id collate "C"), '(none)') from fuel.tankers
  union all
  select '2 Master data', 'fuel.tankers', 21, 'linked to a vehicle', count(vehicle_id)::text from fuel.tankers

  /* ---------------------------------------------------------------- 3 Fuel */
  union all
  select '3 Fuel', 'fuel.diesel_entries', 1, 'rows', count(*)::text from fuel.diesel_entries
  union all
  select '3 Fuel', 'fuel.diesel_entries', 2, 'pump fills', count(*) filter (where tanker_id is null)::text from fuel.diesel_entries
  union all
  select '3 Fuel', 'fuel.diesel_entries', 3, 'tanker fills', count(*) filter (where tanker_id is not null)::text from fuel.diesel_entries
  union all
  select '3 Fuel', 'fuel.diesel_entries', 10 + m.i, 'payment_mode ' || m.v, (select count(*) from fuel.diesel_entries e where e.payment_mode = m.v)::text
  from unnest(enum_range(null::fuel.fill_payment_mode)) with ordinality m(v, i)
  union all
  select '3 Fuel', 'fuel.diesel_entries', 20, 'Σ litres', coalesce(sum(litres), 0)::text from fuel.diesel_entries
  union all
  select '3 Fuel', 'fuel.diesel_entries', 21, 'Σ litres (pump fills)', coalesce(sum(litres) filter (where tanker_id is null), 0)::text from fuel.diesel_entries
  union all
  select '3 Fuel', 'fuel.diesel_entries', 22, 'Σ litres (tanker fills)', coalesce(sum(litres) filter (where tanker_id is not null), 0)::text from fuel.diesel_entries
  union all
  select '3 Fuel', 'fuel.diesel_entries', 23, 'Σ amount (₹, stored)', coalesce(sum(amount), 0)::text from fuel.diesel_entries
  union all
  select '3 Fuel', 'fuel.diesel_entries', 24, 'Σ amount (₹, pump fills)', coalesce(sum(amount) filter (where tanker_id is null), 0)::text from fuel.diesel_entries
  union all
  select '3 Fuel', 'fuel.diesel_entries', 25, 'Σ amount (₹, tanker fills)', coalesce(sum(amount) filter (where tanker_id is not null), 0)::text from fuel.diesel_entries
  union all
  select '3 Fuel', 'fuel.diesel_entries', 26, 'rows with amount null', count(*) filter (where amount is null)::text from fuel.diesel_entries
  union all
  select '3 Fuel', 'fuel.diesel_entries', 27, 'date range', coalesce(min(date) || ' … ' || max(date), '(none)') from fuel.diesel_entries

  union all
  select '3 Fuel', 'fuel.tanker_loads', 1, 'rows', count(*)::text from fuel.tanker_loads
  union all
  select '3 Fuel', 'fuel.tanker_loads', 2, 'opening-stock rows', count(*) filter (where opening)::text from fuel.tanker_loads
  union all
  select '3 Fuel', 'fuel.tanker_loads', 3, 'Σ litres (purchases)', coalesce(sum(litres) filter (where not opening), 0)::text from fuel.tanker_loads
  union all
  select '3 Fuel', 'fuel.tanker_loads', 4, 'Σ amount (₹, purchases)', coalesce(sum(amount) filter (where not opening), 0)::text from fuel.tanker_loads
  union all
  select '3 Fuel', 'fuel.tanker_loads', 5, 'Σ litres (opening stock)', coalesce(sum(litres) filter (where opening), 0)::text from fuel.tanker_loads
  union all
  select '3 Fuel', 'fuel.tanker_loads', 6, 'Σ amount (₹, opening stock)', coalesce(sum(amount) filter (where opening), 0)::text from fuel.tanker_loads
  union all
  select '3 Fuel', 'fuel.tanker_loads', 7, 'date range', coalesce(min(date) || ' … ' || max(date), '(none)') from fuel.tanker_loads
  union all
  select '3 Fuel', 'fuel.tanker_transfers', 1, 'rows', count(*)::text from fuel.tanker_transfers
  union all
  select '3 Fuel', 'fuel.tanker_transfers', 2, 'Σ litres', coalesce(sum(litres), 0)::text from fuel.tanker_transfers
  union all
  select '3 Fuel', 'fuel.tanker_adjustments', 1, 'rows', count(*)::text from fuel.tanker_adjustments
  union all
  select '3 Fuel', 'fuel.tanker_adjustments', 2, 'Σ litres (net ±)', coalesce(sum(litres), 0)::text from fuel.tanker_adjustments
  union all
  select '3 Fuel', 'fuel.tanker_movements (view)', 1, 'net litres per tanker',
         coalesce((select string_agg(tanker_id || ' = ' || n, ', ' order by tanker_id collate "C")
                   from (select tanker_id, sum(litres) as n from fuel.tanker_movements group by 1) x), '(none)')

  union all
  select '3 Fuel', 'fuel.adblue_purchases', 1, 'rows', count(*)::text from fuel.adblue_purchases
  union all
  select '3 Fuel', 'fuel.adblue_purchases', 2, 'opening-stock rows', count(*) filter (where opening)::text from fuel.adblue_purchases
  union all
  select '3 Fuel', 'fuel.adblue_purchases', 3, 'Σ total_litres (purchases)', coalesce(sum(total_litres) filter (where not opening), 0)::text from fuel.adblue_purchases
  union all
  select '3 Fuel', 'fuel.adblue_purchases', 4, 'Σ total_cost (₹, purchases)', coalesce(sum(total_cost) filter (where not opening), 0)::text from fuel.adblue_purchases
  union all
  select '3 Fuel', 'fuel.adblue_purchases', 5, 'Σ total_litres (opening stock)', coalesce(sum(total_litres) filter (where opening), 0)::text from fuel.adblue_purchases
  union all
  select '3 Fuel', 'fuel.adblue_purchases', 6, 'Σ total_cost (₹, opening stock)', coalesce(sum(total_cost) filter (where opening), 0)::text from fuel.adblue_purchases
  union all
  select '3 Fuel', 'fuel.adblue_entries', 1, 'rows', count(*)::text from fuel.adblue_entries
  union all
  select '3 Fuel', 'fuel.adblue_entries', 10 + s.i, 'source ' || s.v || ' rows', (select count(*) from fuel.adblue_entries e where e.source = s.v)::text
  from unnest(enum_range(null::fuel.adblue_source)) with ordinality s(v, i)
  union all
  select '3 Fuel', 'fuel.adblue_entries', 20 + s.i, 'source ' || s.v || ' Σ litres',
         (select coalesce(sum(quantity_litres), 0) from fuel.adblue_entries e where e.source = s.v)::text
  from unnest(enum_range(null::fuel.adblue_source)) with ordinality s(v, i)
  union all
  select '3 Fuel', 'fuel.adblue_entries', 30, 'Σ amount (₹, direct purchases)', coalesce(sum(amount) filter (where source = 'DIRECT'), 0)::text from fuel.adblue_entries
  union all
  select '3 Fuel', 'fuel.adblue_stock_movements (view)', 1, 'net stock litres', coalesce(sum(litres), 0)::text from fuel.adblue_stock_movements

  /* ---------------------------------------------------------------- 4 Finance & billing */
  union all
  select '4 Finance & billing', 'finance.payments', 1, 'rows', count(*)::text from finance.payments
  union all
  select '4 Finance & billing', 'finance.payments', 10 + d.i, 'direction ' || d.v || ' rows', (select count(*) from finance.payments p where p.direction = d.v)::text
  from unnest(enum_range(null::finance.payment_direction)) with ordinality d(v, i)
  union all
  select '4 Finance & billing', 'finance.payments', 20 + d.i, 'direction ' || d.v || ' Σ amount (₹)',
         (select coalesce(sum(amount), 0) from finance.payments p where p.direction = d.v)::text
  from unnest(enum_range(null::finance.payment_direction)) with ordinality d(v, i)
  union all
  select '4 Finance & billing', 'finance.payments', 30 + d.i, 'direction ' || d.v || ' Σ tds_amount (₹)',
         (select coalesce(sum(tds_amount), 0) from finance.payments p where p.direction = d.v)::text
  from unnest(enum_range(null::finance.payment_direction)) with ordinality d(v, i)
  union all
  select '4 Finance & billing', 'finance.payments', 40 + m.i, 'mode ' || m.v || ' rows', (select count(*) from finance.payments p where p.mode = m.v)::text
  from unnest(enum_range(null::finance.payment_mode)) with ordinality m(v, i)
  union all
  select '4 Finance & billing', 'finance.payments', 50 + t.i, 'party ' || t.v || ' rows', (select count(*) from finance.payments p where p.party_type = t.v)::text
  from unnest(enum_range(null::finance.party_type)) with ordinality t(v, i)
  union all
  select '4 Finance & billing', 'finance.payments', 60, 'fuel station payments rows', count(*) filter (where station_id is not null)::text from finance.payments
  union all
  select '4 Finance & billing', 'finance.payments', 61, 'fuel station payments Σ amount (₹)', coalesce(sum(amount) filter (where station_id is not null), 0)::text from finance.payments
  union all
  select '4 Finance & billing', 'finance.payments', 62, 'fuel station payments Σ tds_amount (₹)', coalesce(sum(tds_amount) filter (where station_id is not null), 0)::text from finance.payments
  union all
  select '4 Finance & billing', 'finance.payments', 70, 'date range', coalesce(min(date) || ' … ' || max(date), '(none)') from finance.payments
  union all
  select '4 Finance & billing', 'finance.payment_allocations', 1, 'rows', count(*)::text from finance.payment_allocations
  union all
  select '4 Finance & billing', 'finance.payment_allocations', 2, 'Σ amount (₹)', coalesce(sum(amount), 0)::text from finance.payment_allocations

  union all
  select '4 Finance & billing', 'ops.trips', 1, 'rows', count(*)::text from ops.trips
  union all
  select '4 Finance & billing', 'ops.trips', 10 + s.i, 'status ' || s.v, (select count(*) from ops.trips t where t.status = s.v)::text
  from unnest(enum_range(null::ops.trip_status)) with ordinality s(v, i)
  union all
  select '4 Finance & billing', 'ops.trips', 20, 'on an invoice', count(invoice_id)::text from ops.trips
  union all
  select '4 Finance & billing', 'ops.trips', 21, 'Σ revenue (₹)', coalesce(sum(revenue), 0)::text from ops.trips
  union all
  select '4 Finance & billing', 'ops.trips', 22, 'Σ distance_km', coalesce(sum(distance_km), 0)::text from ops.trips

  union all
  select '4 Finance & billing', 'billing.invoices', 1, 'rows', count(*)::text from billing.invoices
  union all
  select '4 Finance & billing', 'billing.invoices', 10 + s.i, 'status ' || s.v || ' rows', (select count(*) from billing.invoices v where v.status = s.v)::text
  from unnest(enum_range(null::billing.invoice_status)) with ordinality s(v, i)
  union all
  select '4 Finance & billing', 'billing.invoices', 20 + s.i, 'status ' || s.v || ' Σ total (₹)',
         (select coalesce(sum(total), 0) from billing.invoices v where v.status = s.v)::text
  from unnest(enum_range(null::billing.invoice_status)) with ordinality s(v, i)
  union all
  select '4 Finance & billing', 'billing.invoices', 30, 'opening invoices', count(*) filter (where opening)::text from billing.invoices
  union all
  select '4 Finance & billing', 'billing.invoices', 31, 'Σ subtotal (₹)', coalesce(sum(subtotal), 0)::text from billing.invoices
  union all
  select '4 Finance & billing', 'billing.invoices', 32, 'Σ cgst + sgst + igst (₹)', coalesce(sum(cgst + sgst + igst), 0)::text from billing.invoices
  union all
  select '4 Finance & billing', 'billing.invoice_lines', 1, 'rows', count(*)::text from billing.invoice_lines
  union all
  select '4 Finance & billing', 'billing.invoice_lines', 2, 'Σ amount (₹)', coalesce(sum(amount), 0)::text from billing.invoice_lines
  union all
  select '4 Finance & billing', 'billing.invoice_line_trips', 1, 'rows', count(*)::text from billing.invoice_line_trips

  /* ---------------------------------------------------------------- 5 Audit */
  union all
  select '5 Audit', 'audit.events', 1, 'rows', count(*)::text from audit.events
  union all
  select '5 Audit', 'audit.events', 2, 'by module', coalesce((select string_agg(k || ' = ' || n, ', ' order by k collate "C") from (select module as k, count(*) as n from audit.events group by 1) x), '(none)')
  union all
  select '5 Audit', 'audit.events', 10 + a.i, 'action ' || a.v, (select count(*) from audit.events e where e.action = a.v)::text
  from unnest(enum_range(null::audit.action)) with ordinality a(v, i)
  union all
  select '5 Audit', 'audit.events', 90, 'time range (at)', coalesce(min(at) || ' … ' || max(at), '(none)') from audit.events
  union all
  select '5 Audit', 'audit.reviews', 1, 'rows', count(*)::text from audit.reviews

  /* ---------------------------------------------------------------- 6 Fingerprints (md5 of every row, primary-key order) */
  union all select '6 Fingerprints', 'audit.events', 1, 'md5', coalesce(md5(string_agg(md5(x::text), '' order by x.id collate "C")), '(empty)') from audit.events x
  union all select '6 Fingerprints', 'audit.reviews', 1, 'md5', coalesce(md5(string_agg(md5(x::text), '' order by x.event_id collate "C")), '(empty)') from audit.reviews x
  union all select '6 Fingerprints', 'billing.invoice_line_trips', 1, 'md5', coalesce(md5(string_agg(md5(x::text), '' order by x.invoice_id collate "C", x.line_no, x.trip_id collate "C")), '(empty)') from billing.invoice_line_trips x
  union all select '6 Fingerprints', 'billing.invoice_lines', 1, 'md5', coalesce(md5(string_agg(md5(x::text), '' order by x.invoice_id collate "C", x.line_no)), '(empty)') from billing.invoice_lines x
  union all select '6 Fingerprints', 'billing.invoices', 1, 'md5', coalesce(md5(string_agg(md5(x::text), '' order by x.id collate "C")), '(empty)') from billing.invoices x
  union all select '6 Fingerprints', 'core.app_settings', 1, 'md5', coalesce(md5(string_agg(md5(x::text), '' order by x.id)), '(empty)') from core.app_settings x
  union all select '6 Fingerprints', 'core.companies', 1, 'md5', coalesce(md5(string_agg(md5(x::text), '' order by x.code collate "C")), '(empty)') from core.companies x
  union all select '6 Fingerprints', 'core.customer_pricing', 1, 'md5', coalesce(md5(string_agg(md5(x::text), '' order by x.customer_id collate "C")), '(empty)') from core.customer_pricing x
  union all select '6 Fingerprints', 'core.customer_route_rates', 1, 'md5', coalesce(md5(string_agg(md5(x::text), '' order by x.customer_id collate "C", x.line_no)), '(empty)') from core.customer_route_rates x
  union all select '6 Fingerprints', 'core.customer_status_periods', 1, 'md5', coalesce(md5(string_agg(md5(x::text), '' order by x.id collate "C")), '(empty)') from core.customer_status_periods x
  union all select '6 Fingerprints', 'core.customers', 1, 'md5', coalesce(md5(string_agg(md5(x::text), '' order by x.id collate "C")), '(empty)') from core.customers x
  union all select '6 Fingerprints', 'core.drivers', 1, 'md5', coalesce(md5(string_agg(md5(x::text), '' order by x.id collate "C")), '(empty)') from core.drivers x
  union all select '6 Fingerprints', 'core.month_locks', 1, 'md5', coalesce(md5(string_agg(md5(x::text), '' order by x.id collate "C")), '(empty)') from core.month_locks x
  union all select '6 Fingerprints', 'core.role_permissions', 1, 'md5', coalesce(md5(string_agg(md5(x::text), '' order by x.role::text collate "C", x.permission collate "C")), '(empty)') from core.role_permissions x
  union all select '6 Fingerprints', 'core.vehicle_assignments', 1, 'md5', coalesce(md5(string_agg(md5(x::text), '' order by x.id collate "C")), '(empty)') from core.vehicle_assignments x
  union all select '6 Fingerprints', 'core.vehicle_status_periods', 1, 'md5', coalesce(md5(string_agg(md5(x::text), '' order by x.id collate "C")), '(empty)') from core.vehicle_status_periods x
  union all select '6 Fingerprints', 'core.vehicle_types', 1, 'md5', coalesce(md5(string_agg(md5(x::text), '' order by x.code collate "C")), '(empty)') from core.vehicle_types x
  union all select '6 Fingerprints', 'core.vehicles', 1, 'md5', coalesce(md5(string_agg(md5(x::text), '' order by x.id collate "C")), '(empty)') from core.vehicles x
  union all select '6 Fingerprints', 'finance.payment_allocations', 1, 'md5', coalesce(md5(string_agg(md5(x::text), '' order by x.payment_id collate "C", x.invoice_id collate "C")), '(empty)') from finance.payment_allocations x
  union all select '6 Fingerprints', 'finance.payment_categories', 1, 'md5', coalesce(md5(string_agg(md5(x::text), '' order by x.code collate "C")), '(empty)') from finance.payment_categories x
  union all select '6 Fingerprints', 'finance.payments', 1, 'md5', coalesce(md5(string_agg(md5(x::text), '' order by x.id collate "C")), '(empty)') from finance.payments x
  union all select '6 Fingerprints', 'fuel.adblue_entries', 1, 'md5', coalesce(md5(string_agg(md5(x::text), '' order by x.id collate "C")), '(empty)') from fuel.adblue_entries x
  union all select '6 Fingerprints', 'fuel.adblue_purchases', 1, 'md5', coalesce(md5(string_agg(md5(x::text), '' order by x.id collate "C")), '(empty)') from fuel.adblue_purchases x
  union all select '6 Fingerprints', 'fuel.diesel_entries', 1, 'md5', coalesce(md5(string_agg(md5(x::text), '' order by x.id collate "C")), '(empty)') from fuel.diesel_entries x
  union all select '6 Fingerprints', 'fuel.fuel_stations', 1, 'md5', coalesce(md5(string_agg(md5(x::text), '' order by x.id collate "C")), '(empty)') from fuel.fuel_stations x
  union all select '6 Fingerprints', 'fuel.tanker_adjustments', 1, 'md5', coalesce(md5(string_agg(md5(x::text), '' order by x.id collate "C")), '(empty)') from fuel.tanker_adjustments x
  union all select '6 Fingerprints', 'fuel.tanker_loads', 1, 'md5', coalesce(md5(string_agg(md5(x::text), '' order by x.id collate "C")), '(empty)') from fuel.tanker_loads x
  union all select '6 Fingerprints', 'fuel.tanker_transfers', 1, 'md5', coalesce(md5(string_agg(md5(x::text), '' order by x.id collate "C")), '(empty)') from fuel.tanker_transfers x
  union all select '6 Fingerprints', 'fuel.tankers', 1, 'md5', coalesce(md5(string_agg(md5(x::text), '' order by x.id collate "C")), '(empty)') from fuel.tankers x
  union all select '6 Fingerprints', 'ops.trips', 1, 'md5', coalesce(md5(string_agg(md5(x::text), '' order by x.id collate "C")), '(empty)') from ops.trips x
  -- profiles without email / full_name (no personal data hashed)
  union all select '6 Fingerprints', 'public.profiles', 1, 'md5 (id, user_id, role, status, invited_by, activated_at, created_at, updated_at)',
         coalesce(md5(string_agg(md5(concat_ws('|', p.id, p.user_id, p.role, p.status, p.invited_by, p.activated_at, p.created_at, p.updated_at)), '' order by p.id)), '(empty)') from public.profiles p

  /* ---------------------------------------------------------------- 7 Coverage */
  union all
  select '7 Coverage', 'ERP schemas', 1, 'base tables', count(*)::text
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p') and n.nspname in ('public', 'core', 'fuel', 'finance', 'audit', 'ops', 'billing')
  union all
  select '7 Coverage', 'ERP schemas', 2, 'tables not in this snapshot',
         coalesce(string_agg(n.nspname || '.' || c.relname, ', ' order by n.nspname || '.' || c.relname collate "C"), '(none)')
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p') and n.nspname in ('public', 'core', 'fuel', 'finance', 'audit', 'ops', 'billing')
    and n.nspname || '.' || c.relname not in (
      'public.profiles', 'core.role_permissions', 'core.companies', 'core.vehicle_types', 'core.app_settings', 'finance.payment_categories',
      'audit.events', 'audit.reviews', 'core.customers', 'core.customer_status_periods', 'core.customer_pricing', 'core.customer_route_rates',
      'core.drivers', 'core.vehicles', 'core.vehicle_status_periods', 'core.vehicle_assignments', 'core.month_locks', 'fuel.fuel_stations',
      'fuel.tankers', 'fuel.diesel_entries', 'fuel.tanker_loads', 'fuel.tanker_transfers', 'fuel.tanker_adjustments', 'fuel.adblue_purchases',
      'fuel.adblue_entries', 'finance.payments', 'finance.payment_allocations', 'ops.trips', 'billing.invoices', 'billing.invoice_lines',
      'billing.invoice_line_trips')
)
select section, item, metric, value
from snapshot
order by section collate "C", item collate "C", ord;
