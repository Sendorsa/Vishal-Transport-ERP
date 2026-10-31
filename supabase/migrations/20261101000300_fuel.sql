-- Diesel database, phase 1 — design approved by the owner on 1 Nov 2026 (D-1 … D-18). See docs/SUPABASE_DIESEL_DATABASE_SCHEMA.md §3.2, §4 and §5.
--
-- Facts are stored; figures are calculated. No balance, stock, closing or average column exists: station ledgers,
-- tanker stock and cost, AdBlue stock and cost stay calculated by src/domain (stationLedger, valueTankers,
-- valueInventory). The database adds guards that hold whatever the app does: tanker-fill shape, exact amounts,
-- stock never below zero at any point in time (serialised per tanker / for AdBlue), and month locks (RLS).

create type fuel.fill_payment_mode as enum ('CREDIT', 'CASH');
create type fuel.adblue_source as enum ('STOCK', 'DIRECT');
create type fuel.adblue_payment_mode as enum ('CASH', 'UPI', 'NEFT', 'CHEQUE');

/* ------------------------------------------------------------------ fuel stations (master) */

create table fuel.fuel_stations (
  id text primary key default private.new_id('dv'),
  name text not null check (btrim(name) <> ''),
  location text not null default '',
  is_inter_company boolean not null default false, -- VT's own outlet (Vishal Gasoline)
  credit_days integer not null default 30 check (credit_days >= 0),
  status core.entity_status not null default 'ACTIVE',
  -- The internal "Diesel Tanker" source (id dv_tanker): tanker fills point at it. Never a pump we owe (D-6).
  is_tanker_source boolean not null default false,
  -- What we owed (+ Debit) or were owed (− Credit) before the first ledger month, as of opening_balance_date.
  opening_balance numeric(14, 2),
  opening_balance_date date,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check ((opening_balance is null) = (opening_balance_date is null)),
  check (opening_balance is null or opening_balance <> 0), -- 0 removes it (setOpeningBalance)
  check (not is_tanker_source or (id = 'dv_tanker' and opening_balance is null)),
  unique (id, is_tanker_source) -- target of the composite keys below: a tanker fill must use dv_tanker, a load or payment never may
);
create unique index fuel_stations_name_key on fuel.fuel_stations (lower(btrim(name)));
create unique index fuel_stations_one_tanker_source on fuel.fuel_stations (is_tanker_source) where is_tanker_source;
comment on table fuel.fuel_stations is 'Fuel stations (petrol pumps): the one station list. Never deleted (archive). dv_tanker is the internal tanker source, not a pump.';

-- Required reference row: the app identifies tanker fills by vendorId = dv_tanker (src/domain/tanker.ts TANKER_SOURCE_ID).
insert into fuel.fuel_stations (id, name, location, credit_days, is_tanker_source)
values ('dv_tanker', 'Diesel Tanker', 'Company tanker', 0, true);

/* ------------------------------------------------------------------ tankers (master) */

create table fuel.tankers (
  id text primary key default private.new_id('tnk'),
  name text not null check (btrim(name) <> ''),
  -- Every tanker is a registered vehicle (JIO TN70AX9480, Office KA53C0538, Mini KA51AF1429). Stock pools without a
  -- registration exist only in imported browser history, which is out of scope (D-16).
  reg_no text not null check (reg_no <> '' and reg_no = private.norm_reg(reg_no)),
  vehicle_id text unique references core.vehicles (id), -- its own running fuel is a pump fill, never its cargo
  capacity_litres numeric(12, 3) check (capacity_litres > 0),
  status core.entity_status not null default 'ACTIVE',
  notes text not null default '',
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create unique index tankers_name_key on fuel.tankers (lower(btrim(name)));
create unique index tankers_reg_no_key on fuel.tankers (reg_no);

/* ------------------------------------------------------------------ diesel entries (pump fills and tanker fills) */

create table fuel.diesel_entries (
  id text primary key default private.new_id('dsl'),
  company_code text not null references core.companies (code), -- the vehicle's company when the fill was saved
  date date not null,
  vehicle_id text not null references core.vehicles (id),
  -- Stamp of the customer assigned on the fill date. Reports re-resolve it from vehicle_assignments.
  customer_id text references core.customers (id),
  station_id text not null,
  tanker_id text references fuel.tankers (id),
  from_tanker boolean generated always as (tanker_id is not null) stored,
  litres numeric(12, 3) not null check (litres > 0), -- kWh for EV vehicles
  rate numeric(12, 4) not null check (rate > 0), -- a tanker fill's source rate is required (answer 23)
  amount numeric(14, 2) generated always as (round(litres * rate, 2)) stored, -- exact, never a float
  odometer_km numeric(12, 1) not null check (odometer_km >= 0),
  bill_no text not null default '',
  payment_mode fuel.fill_payment_mode not null default 'CREDIT',
  notes text not null default '',
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  -- Tanker fill ⇔ station dv_tanker ⇔ tanker named. A pump fill can never name a tanker, and vice versa.
  foreign key (station_id, from_tanker) references fuel.fuel_stations (id, is_tanker_source),
  -- A tanker fill owes nothing: it is never cash at a pump.
  check (tanker_id is null or payment_mode = 'CREDIT')
);
create index diesel_entries_vehicle_date_idx on fuel.diesel_entries (vehicle_id, date);
create index diesel_entries_station_date_idx on fuel.diesel_entries (station_id, date);
create index diesel_entries_tanker_date_idx on fuel.diesel_entries (tanker_id, date) where tanker_id is not null;
create index diesel_entries_date_idx on fuel.diesel_entries (date);
create index diesel_entries_customer_date_idx on fuel.diesel_entries (customer_id, date);

/* ------------------------------------------------------------------ tanker stock movements */

-- Diesel loaded into a tanker. A load from a station is a purchase owed to it; an opening-stock load (opening = true,
-- no station) is stock already in the tanker when records began — never a purchase (loadsAsStationPurchases).
create table fuel.tanker_loads (
  id text primary key default private.new_id('tkl'),
  tanker_id text not null references fuel.tankers (id),
  date date not null,
  station_id text,
  station_is_tanker boolean not null default false check (not station_is_tanker),
  opening boolean not null default false,
  invoice_no text not null default '',
  litres numeric(12, 3) not null check (litres > 0),
  rate numeric(12, 4) not null check (rate >= 0),
  amount numeric(14, 2) not null check (amount >= 0), -- loads: litres × rate (set by trigger); opening: the stock value
  notes text not null default '',
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  foreign key (station_id, station_is_tanker) references fuel.fuel_stations (id, is_tanker_source), -- a real pump, never dv_tanker
  check (opening = (station_id is null)),
  check (opening or (rate > 0 and amount = round(litres * rate, 2)))
);
create unique index tanker_loads_one_opening on fuel.tanker_loads (tanker_id) where opening;
create index tanker_loads_tanker_date_idx on fuel.tanker_loads (tanker_id, date);
create index tanker_loads_station_date_idx on fuel.tanker_loads (station_id, date) where station_id is not null;

-- Diesel moved between tankers: never a purchase; company stock doesn't change. Delete and re-enter (no edits).
create table fuel.tanker_transfers (
  id text primary key default private.new_id('tkt'),
  date date not null,
  from_tanker_id text not null references fuel.tankers (id),
  to_tanker_id text not null references fuel.tankers (id),
  litres numeric(12, 3) not null check (litres > 0),
  notes text not null default '',
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (from_tanker_id <> to_tanker_id)
);
create index tanker_transfers_from_idx on fuel.tanker_transfers (from_tanker_id, date);
create index tanker_transfers_to_idx on fuel.tanker_transfers (to_tanker_id, date);

-- A correction of one tanker's stock (dip reading, leak, spillage): + adds, − removes. Reason mandatory. No edits.
create table fuel.tanker_adjustments (
  id text primary key default private.new_id('tka'),
  date date not null,
  tanker_id text not null references fuel.tankers (id),
  litres numeric(12, 3) not null check (litres <> 0),
  reason text not null check (length(btrim(reason)) >= 3),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create index tanker_adjustments_tanker_date_idx on fuel.tanker_adjustments (tanker_id, date);

-- Every change to every tanker's stock, signed (+ in, − out), with the app's event order (src/domain/tanker.ts):
-- date; loads / + adjustments (0), transfers out (1), transfers in (2), fills / − adjustments (3); created_at; id.
create view fuel.tanker_movements with (security_invoker = true) as
  select id, tanker_id, date, created_at, case when opening then 'OPENING' else 'LOAD' end as kind, litres, 0 as sort_rank from fuel.tanker_loads
  union all
  select id, tanker_id, date, created_at, 'FILL', -litres, 3 from fuel.diesel_entries where tanker_id is not null
  union all
  select id, from_tanker_id, date, created_at, 'TRANSFER_OUT', -litres, 1 from fuel.tanker_transfers
  union all
  select id, to_tanker_id, date, created_at, 'TRANSFER_IN', litres, 2 from fuel.tanker_transfers
  union all
  select id, tanker_id, date, created_at, 'ADJUST', litres, case when litres < 0 then 3 else 0 end from fuel.tanker_adjustments;
comment on view fuel.tanker_movements is 'Signed stock movements per tanker in the app''s event order. Stock and its value are calculated from these, never stored.';

/* ------------------------------------------------------------------ AdBlue */

-- Bulk purchase into AdBlue stock. Totals are always buckets × per-bucket values (calculated, never typed).
create table fuel.adblue_purchases (
  id text primary key default private.new_id('adp'),
  date date not null,
  vendor_name text not null check (btrim(vendor_name) <> ''), -- free text; there is no AdBlue vendor master
  product text not null default '',
  buckets numeric(10, 3) not null check (buckets > 0),
  litres_per_bucket numeric(10, 3) not null check (litres_per_bucket > 0),
  total_litres numeric(12, 3) generated always as (round(buckets * litres_per_bucket, 2)) stored,
  price_per_bucket numeric(14, 2) not null check (price_per_bucket >= 0),
  total_cost numeric(14, 2) generated always as (round(buckets * price_per_bucket, 2)) stored,
  invoice_no text not null default '',
  notes text not null default '',
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create index adblue_purchases_date_idx on fuel.adblue_purchases (date);

-- A vehicle's AdBlue: STOCK draws from bulk stock (cost = weighted average, calculated on read; stored amount 0);
-- DIRECT is bought from a vendor straight into the vehicle (amount = litres × rate) and never touches bulk stock.
create table fuel.adblue_entries (
  id text primary key default private.new_id('adb'),
  source fuel.adblue_source not null default 'STOCK',
  vehicle_id text not null references core.vehicles (id),
  customer_id text references core.customers (id), -- stamp; reports re-resolve from vehicle_assignments
  date date not null,
  closing_km numeric(12, 1) not null check (closing_km >= 0),
  quantity_litres numeric(12, 3) not null check (quantity_litres > 0),
  vendor_name text,
  rate numeric(12, 4),
  payment_mode fuel.adblue_payment_mode,
  amount numeric(14, 2) generated always as (case when source = 'DIRECT' then round(quantity_litres * rate, 2) else 0 end) stored,
  invoice_no text not null default '',
  notes text not null default '',
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (source = 'DIRECT' or (vendor_name is null and rate is null and payment_mode is null)),
  check (source = 'STOCK' or (btrim(vendor_name) <> '' and rate > 0 and payment_mode is not null))
);
create index adblue_entries_vehicle_date_idx on fuel.adblue_entries (vehicle_id, date);
create index adblue_entries_date_idx on fuel.adblue_entries (date);

-- Signed bulk-stock movements in the app's order (src/domain/adblue-inventory.ts): date; purchases before draws; created_at; id.
create view fuel.adblue_stock_movements with (security_invoker = true) as
  select id, date, created_at, 0 as sort_rank, total_litres as litres from fuel.adblue_purchases
  union all
  select id, date, created_at, 1, -quantity_litres from fuel.adblue_entries where source = 'STOCK';

/* ------------------------------------------------------------------ stock guards (never below zero, concurrency-safe) */

-- The tankers a row touches (old and new versions).
create function private.tanker_ids_of(o jsonb, n jsonb) returns text[]
language sql immutable set search_path = '' as $$
  select coalesce(array_agg(distinct x order by x) filter (where x is not null), '{}')
  from unnest(array[o ->> 'tanker_id', n ->> 'tanker_id', o ->> 'from_tanker_id', o ->> 'to_tanker_id', n ->> 'from_tanker_id', n ->> 'to_tanker_id']) as x
$$;

-- First point where a tanker's running stock would go below zero, if any.
create function private.tanker_shortfall(p_tanker text) returns table (available numeric, needed numeric, on_date date)
language sql stable security definer set search_path = '' as $$
  with m as (
    select date, sort_rank, created_at, id, litres,
           sum(litres) over (order by date, sort_rank, created_at, id collate "C" rows between unbounded preceding and current row) as running
    from fuel.tanker_movements where tanker_id = p_tanker
  )
  select running - litres, -litres, date from m where running < 0 order by date, sort_rank, created_at, id collate "C" limit 1
$$;

-- BEFORE each change: lock the affected tankers' rows (in id order — no deadlock on transfers). Two writers on the
-- same tanker are serialised; the second waits, then checks against the first one's committed rows.
create function private.tanker_stock_lock() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from fuel.tankers
  where id = any (private.tanker_ids_of(case when tg_op <> 'INSERT' then to_jsonb(old) end, case when tg_op <> 'DELETE' then to_jsonb(new) end))
  order by id for update;
  return coalesce(new, old);
end $$;

-- At COMMIT (deferred): every affected tanker's stock must stay ≥ 0 at every point in time.
create function private.tanker_stock_check() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  t text;
  s record;
begin
  foreach t in array private.tanker_ids_of(case when tg_op <> 'INSERT' then to_jsonb(old) end, case when tg_op <> 'DELETE' then to_jsonb(new) end) loop
    select * into s from private.tanker_shortfall(t);
    if found then
      raise exception 'Insufficient tanker inventory in %. Available: % L', (select name from fuel.tankers where id = t), round(s.available, 2)
        using errcode = 'check_violation', detail = format('Tanker %s would go below zero on %s (needs %s L).', t, s.on_date, s.needed);
    end if;
  end loop;
  return null;
end $$;

create function private.adblue_shortfall() returns table (available numeric, needed numeric, on_date date)
language sql stable security definer set search_path = '' as $$
  with m as (
    select date, sort_rank, created_at, id, litres,
           sum(litres) over (order by date, sort_rank, created_at, id collate "C" rows between unbounded preceding and current row) as running
    from fuel.adblue_stock_movements
  )
  select running - litres, -litres, date from m where running < 0 order by date, sort_rank, created_at, id collate "C" limit 1
$$;

-- AdBlue has one bulk stock: one transaction-level advisory lock serialises every stock change.
create function private.adblue_stock_lock() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtext('fuel.adblue_stock'));
  return coalesce(new, old);
end $$;

create function private.adblue_stock_check() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  s record;
begin
  select * into s from private.adblue_shortfall();
  if found then
    raise exception 'Insufficient AdBlue inventory. Available stock: %L', round(s.available, 2)
      using errcode = 'check_violation', detail = format('Stock would go below zero on %s (needs %s L).', s.on_date, s.needed);
  end if;
  return null;
end $$;

-- Deferred triggers fire in name order at COMMIT: <table>_check_stock runs before <table>_require_audit (audit migration),
-- so a stock shortfall reports itself first.
do $$
declare
  t text;
begin
  foreach t in array array['tanker_loads', 'diesel_entries', 'tanker_transfers', 'tanker_adjustments'] loop
    execute format('create trigger %1$s_stock_lock before insert or update or delete on fuel.%1$s for each row execute function private.tanker_stock_lock()', t);
    execute format('create constraint trigger %1$s_check_stock after insert or update or delete on fuel.%1$s deferrable initially deferred for each row execute function private.tanker_stock_check()', t);
  end loop;
  foreach t in array array['adblue_purchases', 'adblue_entries'] loop
    execute format('create trigger %1$s_stock_lock before insert or update or delete on fuel.%1$s for each row execute function private.adblue_stock_lock()', t);
    execute format('create constraint trigger %1$s_check_stock after insert or update or delete on fuel.%1$s deferrable initially deferred for each row execute function private.adblue_stock_check()', t);
  end loop;
end $$;

/* ------------------------------------------------------------------ row guards */

-- Loads: amount = litres × rate for a purchase; an opening load keeps its value and gets rate = value ÷ litres
-- (as api.tankerLoads.createOpening). Opening stock can't be edited — correct it with an adjustment.
create function private.tanker_load_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and old.opening then
    raise exception 'Opening stock can''t be edited — correct it with a stock adjustment.' using errcode = 'check_violation';
  end if;
  if new.opening then
    new.rate := round(new.amount / new.litres, 2);
  else
    new.amount := round(new.litres * new.rate, 2);
  end if;
  return new;
end $$;
create trigger tanker_loads_guard before insert or update on fuel.tanker_loads for each row execute function private.tanker_load_guard();

-- New diesel / AdBlue entries (and restores) only while the vehicle and customer aren't archived on that date.
create function private.entry_open_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  perform private.assert_not_archived_on(new.vehicle_id, new.customer_id, new.date);
  return new;
end $$;
create trigger diesel_entries_open_guard before insert on fuel.diesel_entries for each row execute function private.entry_open_guard();
create trigger adblue_entries_open_guard before insert on fuel.adblue_entries for each row execute function private.entry_open_guard();

-- The vehicle's last known km rises with a new fill (api.diesel.create / restore). Runs as the table owner, so an
-- Employee who may add fills (diesel:create) but not edit vehicles still updates this cache.
create function private.bump_vehicle_odometer() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update core.vehicles set odometer_km = new.odometer_km where id = new.vehicle_id and odometer_km < new.odometer_km;
  return null;
end $$;
create trigger diesel_entries_bump_odometer after insert on fuel.diesel_entries for each row execute function private.bump_vehicle_odometer();

-- Station opening balances are Owner / Dev only and follow the month lock on their date (setOpeningBalance);
-- the tanker source row can't stop being one.
create function private.fuel_station_guard() returns trigger
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
      raise exception 'That month is locked. Only the Owner can change it.' using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end $$;
create trigger fuel_stations_guard before update on fuel.fuel_stations for each row execute function private.fuel_station_guard();

do $$
declare
  t text;
begin
  foreach t in array array['diesel_entries', 'tanker_loads', 'tanker_transfers', 'tanker_adjustments', 'adblue_purchases', 'adblue_entries'] loop
    execute format('create trigger %1$s_no_future before insert or update on fuel.%1$s for each row execute function private.refuse_future_date()', t);
  end loop;
  foreach t in array array['fuel_stations', 'tankers', 'diesel_entries', 'tanker_loads', 'tanker_transfers', 'tanker_adjustments', 'adblue_purchases', 'adblue_entries'] loop
    execute format('create trigger %1$s_touch before update on fuel.%1$s for each row execute function private.touch_updated_at()', t);
  end loop;
end $$;
