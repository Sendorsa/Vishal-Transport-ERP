-- Diesel database, phase 1 — design approved by the owner on 1 Nov 2026 (D-1 … D-18). See docs/SUPABASE_DIESEL_DATABASE_SCHEMA.md §3.1.
--
-- Shared master data. Only the columns the Diesel module reads or writes today; later modules add their own columns
-- or 1:1 extension tables (e.g. billing terms, insurance) by new migrations — never a second customer or vehicle table.
-- Masters are never deleted (archive / restore): no DELETE grant exists for them, and every foreign key is RESTRICT.

create type core.entity_status as enum ('ACTIVE', 'INACTIVE', 'ARCHIVED');
create type core.vehicle_status as enum ('ACTIVE', 'INACTIVE', 'ARCHIVED', 'MAINTENANCE');
create type core.fuel_type as enum ('DIESEL', 'PETROL', 'EV');
create type core.ownership as enum ('OWNED', 'ATTACHED');
create type core.vehicle_category as enum ('BUS', 'VAN', 'CAR', 'TRUCK', 'PICKUP');
create type core.assignment_status as enum ('ACTIVE', 'ENDED');
create type core.lock_state as enum ('OPEN', 'LOCKED');

/* ------------------------------------------------------------------ companies (VT, VTHPL, later more) */

create table core.companies (
  code text primary key check (code ~ '^[A-Z][A-Z0-9]{1,15}$'),
  name text not null check (btrim(name) <> ''),
  -- Prefix of document numbers, e.g. VT-PAY-202627-0001 (CompanyProfile.invoicePrefix).
  invoice_prefix text not null unique check (invoice_prefix ~ '^[A-Z0-9]{1,10}$'),
  is_primary boolean not null default false,
  parent_code text references core.companies (code),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (parent_code is distinct from code)
);
create unique index companies_one_primary on core.companies (is_primary) where is_primary;
comment on table core.companies is 'Group companies. Profile details for invoices (GSTIN, bank, address) are added by the invoicing phase. No bank balance (owner, 31 Oct 2026).';

-- Reference rows the module needs from day one (who paid a station, which company a vehicle belongs to).
insert into core.companies (code, name, invoice_prefix, is_primary, parent_code) values
  ('VT', 'Vishal Transport', 'VT', true, null),
  ('VTHPL', 'VTHPL', 'VTH', false, 'VT');

/* ------------------------------------------------------------------ vehicle types */

create table core.vehicle_types (
  code text primary key check (code ~ '^[A-Z0-9_]+$'),
  name text not null check (btrim(name) <> ''),
  category core.vehicle_category not null,
  default_mileage numeric(6, 2) not null default 0 check (default_mileage >= 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

/* ------------------------------------------------------------------ customers */

create table core.customers (
  id text primary key default private.new_id('cus'),
  code text not null check (btrim(code) <> ''),
  short_name text not null check (btrim(short_name) <> ''),
  name text not null check (btrim(name) <> ''),
  company_code text not null references core.companies (code),
  contact_name text not null default '',
  phone text not null default '',
  city text not null default '',
  -- Small logo (≤128 px data URL) or NULL for the monogram (D-11).
  logo_data_url text check (logo_data_url is null or (logo_data_url like 'data:image/%' and length(logo_data_url) <= 200000)),
  notes text not null default '',
  -- Cache of the open status period (customer_status_periods); reports use the periods (CLAUDE.md "Historical Status").
  status core.entity_status not null default 'ACTIVE',
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create unique index customers_code_key on core.customers (lower(btrim(code)));
create index customers_company_idx on core.customers (company_code);
create index customers_status_idx on core.customers (status);

create table core.customer_status_periods (
  id text primary key default private.new_id('csp'),
  customer_id text not null references core.customers (id),
  status core.entity_status not null,
  start_date date not null,
  end_date date, -- inclusive; NULL = current
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (end_date is null or end_date >= start_date),
  constraint customer_status_periods_no_overlap exclude using gist (customer_id with =, daterange(start_date, end_date, '[]') with &&)
);

/* ------------------------------------------------------------------ drivers */

create table core.drivers (
  id text primary key default private.new_id('drv'),
  name text not null check (btrim(name) <> ''),
  phone text not null default '',
  company_code text not null references core.companies (code),
  status core.entity_status not null default 'ACTIVE',
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
comment on table core.drivers is 'Drivers shown on vehicles. Licence details and payroll belong to a future employee module.';

/* ------------------------------------------------------------------ vehicles */

create table core.vehicles (
  id text primary key default private.new_id('veh'),
  reg_no text not null check (btrim(reg_no) <> ''),
  company_code text not null references core.companies (code),
  type_code text not null references core.vehicle_types (code),
  make text not null default '',
  model text not null default '',
  fuel_type core.fuel_type not null,
  mileage_kmpl numeric(6, 2) not null default 0 check (mileage_kmpl >= 0),
  ownership core.ownership not null default 'OWNED',
  owner_name text,
  status core.vehicle_status not null default 'ACTIVE', -- cache of the open vehicle_status_periods row
  odometer_km numeric(12, 1) not null default 0 check (odometer_km >= 0), -- last known km (raised by diesel entries)
  assigned_customer_id text references core.customers (id), -- cache of the open vehicle_assignments row
  default_driver_id text references core.drivers (id),
  notes text not null default '',
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create unique index vehicles_reg_no_key on core.vehicles (private.norm_reg(reg_no));
create index vehicles_assigned_customer_idx on core.vehicles (assigned_customer_id);
create index vehicles_status_idx on core.vehicles (status);
comment on table core.vehicles is 'Vehicles are permanent assets. Insurance, road tax, permits and EMI belong to future compliance / finance modules.';

create table core.vehicle_status_periods (
  id text primary key default private.new_id('vsp'),
  vehicle_id text not null references core.vehicles (id),
  status core.vehicle_status not null,
  start_date date not null,
  end_date date,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (end_date is null or end_date >= start_date),
  constraint vehicle_status_periods_no_overlap exclude using gist (vehicle_id with =, daterange(start_date, end_date, '[]') with &&)
);

-- Which customer a vehicle works for, and when (CLAUDE.md "Vehicle Assignment History"). Append-only periods: a
-- transfer ends the open one the day before the effective date and starts the next. NULL customer = spare.
create table core.vehicle_assignments (
  id text primary key default private.new_id('vas'),
  vehicle_id text not null references core.vehicles (id),
  customer_id text references core.customers (id),
  start_date date not null,
  end_date date,
  status core.assignment_status not null default 'ACTIVE',
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (end_date is null or end_date >= start_date),
  check ((status = 'ACTIVE') = (end_date is null)),
  -- Two open periods would overlap, so this also allows only one open assignment per vehicle.
  constraint vehicle_assignments_no_overlap exclude using gist (vehicle_id with =, daterange(start_date, end_date, '[]') with &&)
);
create index vehicle_assignments_customer_idx on core.vehicle_assignments (customer_id, start_date);

/* ------------------------------------------------------------------ month locks (shared by every dated module) */

-- The Owner's override of a month's automatic lock (src/domain/month-lock.ts). One row per month.
create table core.month_locks (
  id text primary key default private.new_id('mlk'),
  month text not null unique check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  state core.lock_state not null,
  changed_by_role public.erp_role not null,
  changed_by uuid references public.profiles (id),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

-- canEditMonth: the Owner always; everyone else only while the month is open — the current India month and later
-- are open, earlier months lock by themselves, and an Owner override (month_locks) wins.
create function private.month_open(d date) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_owner() or coalesce(
    (select ml.state = 'OPEN' from core.month_locks ml where ml.month = to_char(d, 'YYYY-MM')),
    date_trunc('month', d) >= date_trunc('month', private.today_ist())
  )
$$;

/* ------------------------------------------------------------------ guards */

-- Archived vehicles and customers keep their history but accept no new record dated in an archived period
-- (assertOpen in src/lib/api/index.ts). Used on INSERT of dated records (new entries and restores).
create function private.assert_not_archived_on(p_vehicle text, p_customer text, d date) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if exists (select 1 from core.vehicle_status_periods p where p.vehicle_id = p_vehicle and p.status = 'ARCHIVED'
             and d between p.start_date and coalesce(p.end_date, 'infinity'::date)) then
    raise exception 'The vehicle is archived on %. Restore it to add new entries.', d using errcode = 'check_violation';
  end if;
  if p_customer is not null and exists (select 1 from core.customer_status_periods p where p.customer_id = p_customer and p.status = 'ARCHIVED'
             and d between p.start_date and coalesce(p.end_date, 'infinity'::date)) then
    raise exception 'The customer is archived on %. Restore it to add new records.', d using errcode = 'check_violation';
  end if;
end $$;

create trigger companies_touch before update on core.companies for each row execute function private.touch_updated_at();
create trigger vehicle_types_touch before update on core.vehicle_types for each row execute function private.touch_updated_at();
create trigger customers_touch before update on core.customers for each row execute function private.touch_updated_at();
create trigger customer_status_periods_touch before update on core.customer_status_periods for each row execute function private.touch_updated_at();
create trigger drivers_touch before update on core.drivers for each row execute function private.touch_updated_at();
create trigger vehicles_touch before update on core.vehicles for each row execute function private.touch_updated_at();
create trigger vehicle_status_periods_touch before update on core.vehicle_status_periods for each row execute function private.touch_updated_at();
create trigger vehicle_assignments_touch before update on core.vehicle_assignments for each row execute function private.touch_updated_at();
create trigger month_locks_touch before update on core.month_locks for each row execute function private.touch_updated_at();
