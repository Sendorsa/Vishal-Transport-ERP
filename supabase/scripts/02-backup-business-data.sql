-- READ-ONLY. Backup of every business table, as one JSON document, before the go-live reset.
-- Run in the SQL Editor; download the single result cell (or copy it) and keep it outside Supabase.
-- Verify: the counts in "row_counts" must equal the number of rows in each "tables" entry, and must match
-- 03-reset-business-data.sql's preview. Tables that don't exist yet (migrations not applied) show null.
-- Alternatively, with CLI access: npx supabase db dump --linked --data-only --schema core,fuel,finance,ops,billing,audit -f <file>.sql
create or replace function pg_temp.rows_of(t text) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  if to_regclass(t) is null then return null; end if;
  execute format('select coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) from %s x', t) into r;
  return r;
end $$;

with t(name) as (values
  ('core.customers'), ('core.customer_status_periods'), ('core.customer_pricing'), ('core.customer_route_rates'),
  ('core.drivers'), ('core.vehicles'), ('core.vehicle_status_periods'), ('core.vehicle_assignments'), ('core.month_locks'),
  ('core.companies'), ('core.vehicle_types'), ('core.app_settings'),
  ('fuel.fuel_stations'), ('fuel.tankers'), ('fuel.diesel_entries'), ('fuel.tanker_loads'), ('fuel.tanker_transfers'),
  ('fuel.tanker_adjustments'), ('fuel.adblue_purchases'), ('fuel.adblue_entries'),
  ('finance.payment_categories'), ('finance.payments'), ('finance.payment_allocations'),
  ('ops.trips'), ('billing.invoices'), ('billing.invoice_lines'), ('billing.invoice_line_trips')
)
select jsonb_build_object(
  'format', 'vishal-erp-db-backup',
  'exported_at', now(),
  'row_counts', (select jsonb_object_agg(name, jsonb_array_length(coalesce(pg_temp.rows_of(name), '[]'::jsonb))) from t),
  'tables', (select jsonb_object_agg(name, pg_temp.rows_of(name)) from t)
) as backup;
