-- The full ERP in the database (docs/SUPABASE_SHARED_DATA_MIGRATION_PLAN.md §10, owner's go-ahead 3 Nov 2026).
-- Additive: no applied migration is edited, no table is dropped or rebuilt. Columns mirror src/lib/types.ts.
--   B-1  master data: billing, insurance, compliance and licence fields; customer pricing
--   B-5  business settings: tax, TDS, SAC, expense categories
--   B-2  ops.trips
--   B-3  billing.invoices / invoice_lines / invoice_line_trips (+ opening invoices)
--   B-4  finance: receipts, expense vouchers, receipt allocations
--   B-7  openings: AdBlue opening stock, vehicle opening odometer
--   and: status-period / assignment rows may be removed by a same-day undo (src/domain/status-history.ts appendPeriod).

/* ================================================================== B-1 master data */
create type core.business_unit as enum ('STAFF_BUS', 'SCHOOL_BUS', 'TAXI', 'GOODS', 'MANPOWER', 'PROPERTY', 'FUEL_RETAIL', 'INTERNAL');
create type core.pricing_model as enum ('FIXED_DAILY_KM_CAP', 'PER_KM_DAILY_MIN', 'ROUTE_DAY_RATE', 'PER_TRIP', 'TAXI_PACKAGE');

-- Company profile printed on invoices. Bank DETAILS only — there is no bank balance (owner, 31 Oct 2026).
alter table core.companies
  add column legal_name text not null default '',
  add column gstin text not null default '',
  add column pan text not null default '',
  add column address text not null default '',
  add column city text not null default '',
  add column state text not null default '',
  add column state_code text not null default '',
  add column phone text not null default '',
  add column email text not null default '',
  add column bank_name text not null default '',
  add column bank_account text not null default '',
  add column ifsc text not null default '';

alter table core.customers
  add column legal_name text not null default '',
  add column business_unit core.business_unit,
  add column gstin text not null default '',
  add column state text not null default '',
  add column state_code text not null default '',
  add column email text not null default '',
  add column credit_days integer not null default 0 check (credit_days >= 0);

-- Pricing terms (Customer.pricing): 1:1 with the customer; route rates are its list. Readable by roles that see
-- customers or price trips — never by a diesel-only reader.
create table core.customer_pricing (
  customer_id text primary key references core.customers (id) on delete cascade,
  model core.pricing_model not null,
  rate numeric(14, 2) not null default 0 check (rate >= 0),
  included_km numeric(12, 1) not null default 0 check (included_km >= 0),
  extra_km_rate numeric(14, 2) not null default 0 check (extra_km_rate >= 0),
  driver_bata numeric(14, 2) not null default 0 check (driver_bata >= 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create table core.customer_route_rates (
  customer_id text not null references core.customers (id) on delete cascade,
  line_no integer not null check (line_no >= 0),
  route text not null default '',
  distance_km numeric(12, 1) not null default 0 check (distance_km >= 0),
  rate numeric(14, 2) not null default 0 check (rate >= 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (customer_id, line_no)
);

alter table core.vehicles
  alter column type_code drop not null, -- the tanker vehicles' type isn't recorded in the books; never invented
  add column year integer check (year is null or year between 1950 and 2100),
  add column seats integer check (seats is null or seats >= 0),
  add column insurance_provider text not null default '',
  add column insurance_policy_no text not null default '',
  add column insurance_valid_till date,
  add column insurance_premium numeric(14, 2) not null default 0 check (insurance_premium >= 0),
  add column road_tax_valid_till date,
  add column road_tax_amount numeric(14, 2) not null default 0 check (road_tax_amount >= 0),
  add column road_tax_period text not null default 'ANNUAL' check (road_tax_period in ('QUARTERLY', 'ANNUAL')),
  add column fitness_valid_till date,
  add column permit_valid_till date,
  add column emi_amount numeric(14, 2) not null default 0 check (emi_amount >= 0),
  -- B-7: the odometer at the vehicle's last fill before go-live (the first fill's KM Run starts from it).
  add column opening_odometer_km numeric(12, 1) check (opening_odometer_km >= 0),
  add column opening_odometer_date date,
  add constraint vehicles_opening_odometer_pair check ((opening_odometer_km is null) = (opening_odometer_date is null));

alter table core.drivers
  add column license_no text not null default '',
  add column license_valid_till date;

alter table core.vehicle_types add column default_seats integer check (default_seats is null or default_seats >= 0);
-- The standard vehicle-type list every clean workspace starts with (src/lib/storage/seed.ts DEFAULT_SETTINGS): a
-- classification, editable in Settings — not business data. Existing rows are kept as they are. Audited like any
-- settings change (the audit-presence check binds migrations too).
insert into audit.events (actor_kind, action, module, record_type, record_id, label, note)
values ('SYSTEM', 'UPDATED', 'Settings', 'Settings', 'settings', 'Business settings', 'Standard vehicle types added by migration 20261103000200');
insert into core.vehicle_types (code, name, category, default_seats, default_mileage) values
  ('BUS_55', '55-seater bus', 'BUS', 55, 4.3),
  ('BUS_41', '41-seater bus', 'BUS', 41, 4.9),
  ('BUS_32', '32-seater bus', 'BUS', 32, 6.0),
  ('MINI_24', '24-seater mini bus', 'BUS', 24, 7.0),
  ('TT_17', 'Tempo Traveller (17)', 'VAN', 17, 8.5),
  ('SUV', 'SUV (Innova Crysta)', 'CAR', 7, 11),
  ('SEDAN', 'Sedan (Dzire / Etios)', 'CAR', 4, 17),
  ('TRUCK_19', '19 ft truck', 'TRUCK', null, 6),
  ('PICKUP', 'Pickup (Bolero / Ace)', 'PICKUP', null, 12)
on conflict (code) do nothing;

create trigger customer_pricing_touch before update on core.customer_pricing for each row execute function private.touch_updated_at();
create trigger customer_route_rates_touch before update on core.customer_route_rates for each row execute function private.touch_updated_at();

-- The opening odometer is an Owner-level opening (Owner / Dev) and follows the month lock of its date.
create function private.vehicle_opening_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (new.opening_odometer_km, new.opening_odometer_date) is distinct from
     (case when tg_op = 'UPDATE' then old.opening_odometer_km end, case when tg_op = 'UPDATE' then old.opening_odometer_date end)
     and private.erp_role() is not null then
    if not private.is_owner_or_dev() then
      raise exception 'Only the Owner or Dev can record opening odometers.' using errcode = 'insufficient_privilege';
    end if;
    if (tg_op = 'UPDATE' and old.opening_odometer_date is not null and not private.month_open(old.opening_odometer_date))
       or (new.opening_odometer_date is not null and not private.month_open(new.opening_odometer_date)) then
      raise exception 'That month is locked. Only the Owner or Dev can change it.' using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end $$;
create trigger vehicles_opening_guard before insert or update on core.vehicles for each row execute function private.vehicle_opening_guard();

/* ------------------------------------------------------------------ status periods and assignments: same-day undo */
-- appendPeriod replaces a change made the same day (archive then restore today; a transfer corrected the same day),
-- which removes the last period row. The app audits it on the vehicle / customer (UPDATED, ARCHIVED, RESTORED,
-- TRANSFERRED), never as a DELETED event, so these rows accept any event of their parent.
create function private.require_parent_audit_event() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  o jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  n jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  rid text := coalesce(n, o) ->> tg_argv[0];
begin
  if tg_op = 'UPDATE' and (o - 'updated_at') = (n - 'updated_at') then
    return null;
  end if;
  if not exists (select 1 from audit.events e where e.txid = txid_current() and e.record_id = rid) then
    raise exception '% of %.% (record %) has no audit event in the same transaction.', tg_op, tg_table_schema, tg_table_name, rid
      using errcode = 'integrity_constraint_violation';
  end if;
  return null;
end $$;
drop trigger customer_status_periods_require_audit on core.customer_status_periods;
drop trigger vehicle_status_periods_require_audit on core.vehicle_status_periods;
drop trigger vehicle_assignments_require_audit on core.vehicle_assignments;
create constraint trigger customer_status_periods_require_audit after insert or update or delete on core.customer_status_periods
  deferrable initially deferred for each row execute function private.require_parent_audit_event('customer_id');
create constraint trigger vehicle_status_periods_require_audit after insert or update or delete on core.vehicle_status_periods
  deferrable initially deferred for each row execute function private.require_parent_audit_event('vehicle_id');
create constraint trigger vehicle_assignments_require_audit after insert or update or delete on core.vehicle_assignments
  deferrable initially deferred for each row execute function private.require_parent_audit_event('vehicle_id');
create constraint trigger customer_pricing_require_audit after insert or update or delete on core.customer_pricing
  deferrable initially deferred for each row execute function private.require_parent_audit_event('customer_id');
create constraint trigger customer_route_rates_require_audit after insert or update or delete on core.customer_route_rates
  deferrable initially deferred for each row execute function private.require_parent_audit_event('customer_id');

/* ================================================================== B-5 business settings */
create table core.app_settings (
  id integer primary key default 1 check (id = 1), -- one row
  default_tax_rate numeric(5, 2) not null check (default_tax_rate >= 0),
  tds_rate numeric(5, 2) not null check (tds_rate >= 0), -- customer TDS on receipts (u/s 194C)
  sac_code text not null default '',
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
-- Reference configuration (src/lib/storage/seed.ts DEFAULT_SETTINGS), not business data.
insert into core.app_settings (id, default_tax_rate, tds_rate, sac_code) values (1, 18, 2, '996601');
create trigger app_settings_touch before update on core.app_settings for each row execute function private.touch_updated_at();

insert into finance.payment_categories (code, name, kind, vehicle_linked) values
  ('DRIVER_SALARY', 'Driver salary', 'EXPENSE', true),
  ('STAFF_SALARY', 'Office & supervisory salary', 'EXPENSE', false),
  ('EMI', 'Vehicle EMI', 'EXPENSE', true),
  ('TYRE', 'Tyres', 'EXPENSE', true),
  ('MAINTENANCE', 'Maintenance & repairs', 'EXPENSE', true),
  ('INSURANCE', 'Insurance', 'EXPENSE', true),
  ('ROAD_TAX', 'Road tax & permits', 'EXPENSE', true),
  ('ATTACH_VEHICLE', 'Attached vehicle hire', 'EXPENSE', true),
  ('TOLL', 'Toll & FASTag', 'EXPENSE', false),
  ('RENT', 'Rent', 'EXPENSE', false),
  ('OFFICE', 'Office & admin', 'EXPENSE', false),
  ('OTHER', 'Other expense', 'EXPENSE', false),
  ('GST_PAYMENT', 'GST remittance', 'SETTLEMENT', false)
on conflict (code) do nothing;

/* ================================================================== B-2 trips */
create schema ops;
comment on schema ops is 'Operations: trips.';
create type ops.trip_status as enum ('PLANNED', 'COMPLETED', 'CANCELLED');

create table ops.trips (
  id text primary key default private.new_id('trp'),
  trip_no text not null unique,
  company_code text not null references core.companies (code),
  date date not null,
  customer_id text not null references core.customers (id),
  vehicle_id text not null references core.vehicles (id),
  driver_id text references core.drivers (id),
  route text not null default '',
  start_km numeric(12, 1) not null default 0 check (start_km >= 0),
  end_km numeric(12, 1) not null default 0 check (end_km >= 0),
  distance_km numeric(12, 1) not null default 0 check (distance_km >= 0),
  pricing_model core.pricing_model not null,
  -- Priced when saved (calculateTripRevenue): later changes to the customer's terms never move history.
  base_amount numeric(14, 2) not null default 0,
  extra_km_amount numeric(14, 2) not null default 0,
  bata_amount numeric(14, 2) not null default 0,
  toll_parking numeric(14, 2) not null default 0,
  revenue numeric(14, 2) not null default 0,
  status ops.trip_status not null,
  invoice_id text, -- foreign key added with billing below
  notes text not null default '',
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create index trips_date_idx on ops.trips (date);
create index trips_customer_date_idx on ops.trips (customer_id, date);
create index trips_vehicle_date_idx on ops.trips (vehicle_id, date);
create index trips_invoice_idx on ops.trips (invoice_id) where invoice_id is not null;
create trigger trips_open_guard before insert on ops.trips for each row execute function private.entry_open_guard();
create trigger trips_touch before update on ops.trips for each row execute function private.touch_updated_at();

-- A trip on an invoice is locked: only the invoice operation may set or clear invoice_id (cancel releases it).
create function private.invoiced_trip_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.invoice_id is not null and (
    tg_op = 'DELETE' or (to_jsonb(new) - 'invoice_id' - 'updated_at') <> (to_jsonb(old) - 'invoice_id' - 'updated_at')
  ) then
    raise exception 'Trip % is on an invoice. Cancel the invoice first.', old.trip_no using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end $$;
create trigger trips_invoiced_guard before update or delete on ops.trips for each row execute function private.invoiced_trip_guard();

/* ================================================================== B-3 billing */
create schema billing;
comment on schema billing is 'Customer invoicing.';
create type billing.invoice_status as enum ('DRAFT', 'ISSUED', 'CANCELLED');
create type billing.tax_type as enum ('CGST_SGST', 'IGST');

create table billing.invoices (
  id text primary key default private.new_id('inv'),
  invoice_no text not null unique,
  company_code text not null references core.companies (code),
  customer_id text not null references core.customers (id),
  date date not null,
  due_date date not null,
  period_from date not null,
  period_to date not null,
  subtotal numeric(14, 2) not null check (subtotal >= 0),
  tax_type billing.tax_type not null,
  tax_rate numeric(5, 2) not null default 0 check (tax_rate >= 0),
  cgst numeric(14, 2) not null default 0 check (cgst >= 0),
  sgst numeric(14, 2) not null default 0 check (sgst >= 0),
  igst numeric(14, 2) not null default 0 check (igst >= 0),
  total numeric(14, 2) not null,
  status billing.invoice_status not null,
  -- B-7: an invoice still unpaid at go-live, entered with its original number, dates and the amount outstanding.
  opening boolean not null default false,
  notes text not null default '',
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (total = subtotal + cgst + sgst + igst),
  check (tax_type = 'CGST_SGST' or (cgst = 0 and sgst = 0)),
  check (tax_type = 'IGST' or igst = 0),
  check (not opening or (cgst = 0 and sgst = 0 and igst = 0 and total > 0 and status <> 'DRAFT'))
);
create index invoices_customer_date_idx on billing.invoices (customer_id, date);
create index invoices_date_idx on billing.invoices (date);

-- Line ids (ln_1, ln_m1…) are unique within their invoice only (src/domain/invoicing.ts).
create table billing.invoice_lines (
  invoice_id text not null references billing.invoices (id) on delete cascade,
  line_no integer not null check (line_no >= 0),
  line_id text not null,
  description text not null default '',
  sac text not null default '',
  quantity numeric(12, 3) not null default 0,
  unit text not null default '',
  rate numeric(14, 4) not null default 0,
  amount numeric(14, 2) not null default 0,
  vehicle_id text references core.vehicles (id),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (invoice_id, line_no),
  unique (invoice_id, line_id)
);
create table billing.invoice_line_trips (
  invoice_id text not null,
  line_no integer not null,
  trip_id text not null references ops.trips (id),
  primary key (invoice_id, line_no, trip_id),
  foreign key (invoice_id, line_no) references billing.invoice_lines (invoice_id, line_no) on delete cascade
);
create index invoice_line_trips_trip_idx on billing.invoice_line_trips (trip_id);

alter table ops.trips add constraint trips_invoice_fk foreign key (invoice_id) references billing.invoices (id);

-- An invoice is never edited after it is saved: only its status changes (issue, cancel).
create function private.invoice_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (to_jsonb(new) - 'status' - 'updated_at') <> (to_jsonb(old) - 'status' - 'updated_at') then
    raise exception 'An invoice can''t be edited. Cancel it and raise a new one.' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger invoices_guard before update on billing.invoices for each row execute function private.invoice_guard();
create trigger invoices_touch before update on billing.invoices for each row execute function private.touch_updated_at();

-- Lines add up to the subtotal; an opening invoice has no lines (checked at COMMIT, after lines are written).
create function private.invoice_lines_check() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  inv billing.invoices;
  s numeric;
  n integer;
begin
  select * into inv from billing.invoices where id = coalesce(new.id, old.id);
  if not found then
    return null;
  end if;
  select coalesce(sum(amount), 0), count(*) into s, n from billing.invoice_lines where invoice_id = inv.id;
  if inv.opening and n > 0 then
    raise exception 'An opening invoice has no lines.' using errcode = 'check_violation';
  end if;
  if not inv.opening and s <> inv.subtotal then
    raise exception 'Invoice % lines add up to % but its subtotal is %.', inv.invoice_no, s, inv.subtotal using errcode = 'check_violation';
  end if;
  return null;
end $$;
create constraint trigger invoices_check_lines after insert on billing.invoices
  deferrable initially deferred for each row execute function private.invoice_lines_check();

/* ================================================================== B-4 receipts, expenses, allocations */
alter table finance.payments drop constraint payments_phase1_fuel_station_only;
alter table finance.payments
  add column customer_id text references core.customers (id),
  add column vehicle_id text references core.vehicles (id);
create index payments_customer_date_idx on finance.payments (customer_id, date) where customer_id is not null;
create index payments_vehicle_date_idx on finance.payments (vehicle_id, date) where vehicle_id is not null;
comment on schema finance is 'Money movements: fuel station payments and TDS, receipts, expense vouchers, receipt allocations.';

create table finance.payment_allocations (
  payment_id text not null references finance.payments (id) on delete cascade,
  invoice_id text not null references billing.invoices (id),
  amount numeric(14, 2) not null check (amount > 0),
  created_at timestamptz not null default clock_timestamp(),
  primary key (payment_id, invoice_id)
);
create index payment_allocations_invoice_idx on finance.payment_allocations (invoice_id);

-- A receipt settles only an issued invoice, and an invoice is never settled beyond its total (+ ₹0.50, the app's
-- rounding tolerance) — also when two receipts are saved at the same moment (the invoice row is locked first).
create function private.allocation_check() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  inv billing.invoices;
  settled numeric;
begin
  select * into inv from billing.invoices where id = new.invoice_id for update;
  if inv.status <> 'ISSUED' then
    raise exception 'Can only allocate to issued invoices.' using errcode = 'check_violation';
  end if;
  select coalesce(sum(a.amount + 0), 0) into settled from finance.payment_allocations a where a.invoice_id = new.invoice_id;
  if settled > inv.total + 0.5 then
    raise exception 'Allocation exceeds outstanding on %.', inv.invoice_no using errcode = 'check_violation';
  end if;
  return null;
end $$;
create constraint trigger payment_allocations_check after insert or update on finance.payment_allocations
  deferrable initially deferred for each row execute function private.allocation_check();

/* ================================================================== B-7 AdBlue opening stock */
alter table fuel.adblue_purchases
  add column opening boolean not null default false,
  drop constraint adblue_purchases_vendor_name_check,
  add constraint adblue_purchases_vendor_check check (opening or btrim(vendor_name) <> '');
create unique index adblue_purchases_one_opening on fuel.adblue_purchases (opening) where opening;
create function private.adblue_opening_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.opening or new.opening then
    raise exception 'Opening stock can''t be edited. Delete it with a reason and record it again.' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger adblue_purchases_opening_guard before update on fuel.adblue_purchases for each row execute function private.adblue_opening_guard();

/* ================================================================== audit presence on the new tables */
do $$
declare
  r record;
begin
  for r in select * from (values
    ('core', 'app_settings', '''=settings'''),
    ('finance', 'payment_categories', '''=settings'''),
    ('ops', 'trips', '''id'', ''invoice_id'''), -- invoice_id alone changes with the invoice's own event
    ('billing', 'invoices', '''id'''),
    ('billing', 'invoice_lines', '''invoice_id''')
  ) as t (sch, tbl, args) loop
    execute format(
      'create constraint trigger %2$s_require_audit after insert or update or delete on %1$s.%2$s deferrable initially deferred for each row execute function private.require_audit_event(%3$s)',
      r.sch, r.tbl, r.args);
  end loop;
end $$;
create constraint trigger payment_allocations_require_audit after insert or update or delete on finance.payment_allocations
  deferrable initially deferred for each row execute function private.require_parent_audit_event('payment_id');

/* ================================================================== grants */
revoke all on schema ops, billing from public, anon;
grant usage on schema ops, billing to authenticated, service_role;
revoke all on all tables in schema ops, billing from public, anon, authenticated;
grant all on all tables in schema ops, billing to service_role;
grant all on core.app_settings, core.customer_pricing, core.customer_route_rates, finance.payment_allocations to service_role;
revoke all on core.app_settings, core.customer_pricing, core.customer_route_rates, finance.payment_allocations from public, anon, authenticated;
-- New helper functions here are trigger functions (no EXECUTE needed at run time). Never re-grant the whole private
-- schema: 20261101000700_accounts.sql revoked the account functions from every API role on purpose.
revoke all on function private.vehicle_opening_guard(), private.require_parent_audit_event(), private.invoiced_trip_guard(),
  private.invoice_guard(), private.invoice_lines_check(), private.allocation_check(), private.adblue_opening_guard()
from public, anon, authenticated;

grant select on all tables in schema ops, billing to authenticated;
grant select on core.app_settings, core.customer_pricing, core.customer_route_rates, finance.payment_allocations to authenticated;
grant update on core.app_settings to authenticated;
grant insert, update on finance.payment_categories to authenticated;
grant insert, update, delete on core.customer_pricing, core.customer_route_rates to authenticated;
grant delete on core.customer_status_periods, core.vehicle_status_periods, core.vehicle_assignments to authenticated;
grant insert, update, delete on ops.trips to authenticated;
grant insert, update on billing.invoices to authenticated; -- no delete: cancel only
grant insert on billing.invoice_lines, billing.invoice_line_trips to authenticated;
grant insert, delete on finance.payment_allocations to authenticated;

/* ================================================================== RLS */
alter table core.app_settings enable row level security;
alter table core.customer_pricing enable row level security;
alter table core.customer_route_rates enable row level security;
alter table ops.trips enable row level security;
alter table billing.invoices enable row level security;
alter table billing.invoice_lines enable row level security;
alter table billing.invoice_line_trips enable row level security;
alter table finance.payment_allocations enable row level security;

create policy "ERP users read" on core.app_settings for select to authenticated using ((select private.erp_role()) is not null);
create policy "Settings edit" on core.app_settings for update to authenticated using ((select private.can('settings', 'edit')));
create policy "Settings add categories" on finance.payment_categories for insert to authenticated with check ((select private.can('settings', 'edit')));
create policy "Settings edit categories" on finance.payment_categories for update to authenticated using ((select private.can('settings', 'edit')));

create policy "Read pricing" on core.customer_pricing for select to authenticated
  using ((select private.can('customers', 'view')) or (select private.can('trips', 'view')));
create policy "Write pricing" on core.customer_pricing for all to authenticated
  using ((select private.can('customers', 'edit')) or (select private.can('customers', 'create')))
  with check ((select private.can('customers', 'edit')) or (select private.can('customers', 'create')));
create policy "Read route rates" on core.customer_route_rates for select to authenticated
  using ((select private.can('customers', 'view')) or (select private.can('trips', 'view')));
create policy "Write route rates" on core.customer_route_rates for all to authenticated
  using ((select private.can('customers', 'edit')) or (select private.can('customers', 'create')))
  with check ((select private.can('customers', 'edit')) or (select private.can('customers', 'create')));

-- Same-day undo of a status change or a transfer (see above).
create policy "Undo customer status" on core.customer_status_periods for delete to authenticated using ((select private.can('customers', 'edit')));
create policy "Undo vehicle status" on core.vehicle_status_periods for delete to authenticated using ((select private.can('vehicles', 'edit')));
create policy "Undo assignments" on core.vehicle_assignments for delete to authenticated
  using ((select private.can('vehicles', 'edit')) and private.month_open(start_date));

-- Trips (Monthly Sheet Lock as diesel entries).
create policy "Read trips" on ops.trips for select to authenticated using ((select private.can('trips', 'view')) or (select private.can('invoices', 'view')));
create policy "Add trips" on ops.trips for insert to authenticated with check ((select private.can('trips', 'create')) and private.month_open(date));
create policy "Edit trips" on ops.trips for update to authenticated
  using (((select private.can('trips', 'edit')) or (select private.can('invoices', 'edit')) or (select private.can('invoices', 'create'))) and private.month_open(date))
  with check (private.month_open(date));
create policy "Delete trips" on ops.trips for delete to authenticated using ((select private.can('trips', 'delete')) and private.month_open(date));

-- Invoices: never deleted; opening invoices are an Owner-level opening (Owner / Dev).
create policy "Read invoices" on billing.invoices for select to authenticated using ((select private.can('invoices', 'view')));
create policy "Add invoices" on billing.invoices for insert to authenticated
  with check ((select private.can('invoices', 'create')) and (not opening or (select private.is_owner_or_dev())));
create policy "Issue or cancel invoices" on billing.invoices for update to authenticated using ((select private.can('invoices', 'edit')));
create policy "Read invoice lines" on billing.invoice_lines for select to authenticated using ((select private.can('invoices', 'view')));
create policy "Add invoice lines" on billing.invoice_lines for insert to authenticated with check ((select private.can('invoices', 'create')));
create policy "Read invoice trips" on billing.invoice_line_trips for select to authenticated using ((select private.can('invoices', 'view')));
create policy "Add invoice trips" on billing.invoice_line_trips for insert to authenticated with check ((select private.can('invoices', 'create')));

-- Payments: station payments stay readable to diesel users (station ledger, D-3); receipts and expenses only to
-- payment users. A vehicle's maintenance voucher may be logged by whoever may edit the vehicle.
drop policy "Read payments" on finance.payments;
create policy "Read payments" on finance.payments for select to authenticated
  using ((select private.can('payments', 'view')) or ((select private.can('diesel', 'view')) and category_code = 'DIESEL_SETTLEMENT'));
drop policy "Record payments" on finance.payments;
create policy "Record payments" on finance.payments for insert to authenticated
  with check (
    ((select private.can('payments', 'create')) or ((select private.can('vehicles', 'edit')) and direction = 'OUT' and vehicle_id is not null))
    and private.month_open(date)
  );
create policy "Read allocations" on finance.payment_allocations for select to authenticated using ((select private.can('payments', 'view')));
create policy "Add allocations" on finance.payment_allocations for insert to authenticated with check ((select private.can('payments', 'create')));
create policy "Delete allocations" on finance.payment_allocations for delete to authenticated using ((select private.can('payments', 'delete')));

-- AdBlue opening stock: Owner / Dev; never edited.
drop policy "Add AdBlue purchases" on fuel.adblue_purchases;
create policy "Add AdBlue purchases" on fuel.adblue_purchases for insert to authenticated
  with check (private.month_open(date) and case when opening then (select private.is_owner_or_dev()) else (select private.can('diesel', 'create')) end);
