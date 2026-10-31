-- Diesel database, phase 1 — design approved by the owner on 1 Nov 2026 (D-1 … D-18). See docs/SUPABASE_DIESEL_DATABASE_SCHEMA.md §3.3 and §6.
--
-- One payments table for every money movement, shaped like the app's Payment (src/lib/types.ts). Phase 1 stores only
-- fuel station payments and TDS (constraint payments_phase1_fuel_station_only). The Payments / invoicing phase drops
-- that constraint and adds customer_id, vehicle_id and allocations by new migrations — the same rows stay, nothing is
-- duplicated or moved. A station payment is never a second copy of a purchase: purchases are the fuel rows.

create type finance.payment_direction as enum ('IN', 'OUT');
create type finance.payment_mode as enum ('NEFT', 'UPI', 'CHEQUE', 'CASH', 'TDS');
create type finance.party_type as enum ('CUSTOMER', 'VENDOR', 'EMPLOYEE', 'OTHER');
create type finance.category_kind as enum ('EXPENSE', 'SETTLEMENT');

-- Expense heads (Settings → expenseCategories). SETTLEMENT categories pay off a liability and are not P&L expense.
create table finance.payment_categories (
  code text primary key check (code ~ '^[A-Z][A-Z0-9_]*$'),
  name text not null check (btrim(name) <> ''),
  kind finance.category_kind not null,
  vehicle_linked boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
-- Required reference row: station payments are vouchers in this category (STATION_PAYMENT_CATEGORY).
insert into finance.payment_categories (code, name, kind) values ('DIESEL_SETTLEMENT', 'Diesel vendor payment', 'SETTLEMENT');

create table finance.payments (
  id text primary key default private.new_id('pay'),
  -- {company prefix}-{PAY|RCT}-{FY}-0001, assigned by finance_payments_number when not given (a restore keeps its own).
  payment_no text not null unique,
  company_code text not null references core.companies (code), -- the company that paid ("Paid by")
  direction finance.payment_direction not null,
  date date not null, -- the day the money was paid: the ledger uses this date
  party_type finance.party_type not null,
  station_id text,
  station_is_tanker boolean not null default false check (not station_is_tanker),
  party_name text not null check (btrim(party_name) <> ''),
  category_code text references finance.payment_categories (code),
  amount numeric(14, 2) not null default 0 check (amount >= 0),
  -- TDS: never money paid. On a station payment (mode TDS, amount 0) it settles that much of what we owe the station.
  tds_amount numeric(14, 2) not null default 0 check (tds_amount >= 0),
  mode finance.payment_mode not null,
  reference text not null default '',
  notes text not null default '',
  -- "Paid against": the month's purchases it was paid for (informational; never moves it in the ledger).
  for_month text check (for_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  foreign key (station_id, station_is_tanker) references fuel.fuel_stations (id, is_tanker_source), -- never dv_tanker
  check (amount > 0 or tds_amount > 0),
  check (for_month is null or private.month_start(for_month) <= date), -- not against a later month
  -- Fuel station TDS (answer 14): amount 0, dated the month's last day, paid against its own month.
  check (category_code is distinct from 'DIESEL_SETTLEMENT' or (
    (mode = 'TDS') = (amount = 0)
    and (mode = 'TDS') = (tds_amount > 0)
    and (mode <> 'TDS' or (for_month is not null and date = private.month_end(date) and private.month_start(for_month) = date_trunc('month', date)::date))
  )),
  constraint payments_phase1_fuel_station_only check (
    direction = 'OUT' and party_type = 'VENDOR' and category_code = 'DIESEL_SETTLEMENT' and station_id is not null
  )
);
-- One TDS entry per station per month (TDS is always dated the month's last day).
create unique index payments_one_tds_per_station_month on finance.payments (station_id, date) where mode = 'TDS';
create index payments_station_date_idx on finance.payments (station_id, date) where station_id is not null;
create index payments_date_idx on finance.payments (date);

-- Voucher numbers exactly as nextSeq in src/lib/api/index.ts: the next number after the highest existing one for the
-- prefix (FY = April–March, e.g. 202627). Serialised per prefix, so two writers never get the same number; the unique
-- key is the backstop.
create function private.assign_payment_no() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  fy int := extract(year from new.date)::int - case when extract(month from new.date) < 4 then 1 else 0 end;
  prefix text;
  n int;
begin
  if new.payment_no is not null then
    return new;
  end if;
  select c.invoice_prefix || '-' || case when new.direction = 'IN' then 'RCT' else 'PAY' end || '-' || fy || lpad(((fy + 1) % 100)::text, 2, '0') || '-'
    into prefix from core.companies c where c.code = new.company_code;
  perform pg_advisory_xact_lock(hashtext('finance.payment_no:' || prefix));
  select coalesce(max(substr(p.payment_no, length(prefix) + 1)::int), 0) + 1 into n
    from finance.payments p where p.payment_no like prefix || '%' and substr(p.payment_no, length(prefix) + 1) ~ '^\d+$';
  new.payment_no := prefix || lpad(n::text, 4, '0');
  return new;
end $$;

create trigger finance_payments_number before insert on finance.payments for each row execute function private.assign_payment_no();
create trigger payments_no_future before insert or update on finance.payments for each row execute function private.refuse_future_date();
create trigger payments_touch before update on finance.payments for each row execute function private.touch_updated_at();
create trigger payment_categories_touch before update on finance.payment_categories for each row execute function private.touch_updated_at();
