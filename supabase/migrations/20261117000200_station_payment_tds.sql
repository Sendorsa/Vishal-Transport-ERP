-- Fuel Stations → Add Payment → "Deduct TDS?" (owner, 17 Nov 2026). Run ONCE in the Supabase Dashboard → SQL Editor as
-- one script. It opens its own transaction: any error — or a guard below — changes nothing.
--
-- A station payment voucher (category DIESEL_SETTLEMENT) may now carry TDS withheld from it:
--   amount      = what reached the station (bank / cash)
--   tds_amount  = round(total settled × tds_rate / 100, 2)      total settled = amount + tds_amount
--   tds_rate    = the TDS % applied (new column; NULL = no TDS deducted on this payment)
-- The ledger already counts amount + tds_amount as Payments Made (src/domain/station-ledger.ts), so the balance falls by
-- the full total; cash flow already counts only `amount` (money out) — TDS is never counted twice.
-- Unchanged: the monthly TDS entry (mode TDS, amount 0, dated the month's last day, one per station per month — the
-- unique index payments_one_tds_per_station_month is untouched); every other payment (receipts, vouchers) — tds_rate
-- stays NULL there. Every existing row already satisfies the new rule (station vouchers have tds_amount 0 unless mode
-- TDS), so no row changes.
--
-- What changes: one CHECK constraint on finance.payments is replaced (the station-voucher TDS rule, which allowed
-- tds_amount only on the monthly TDS entry) by payments_station_tds_check below, and the column tds_rate is added.
-- Rollback (only while no payment has tds_rate set — check first: select count(*) from finance.payments where tds_rate is not null):
--   begin;
--   alter table finance.payments drop constraint payments_station_tds_check, drop column tds_rate;
--   alter table finance.payments add check (category_code is distinct from 'DIESEL_SETTLEMENT' or (
--     (mode = 'TDS') = (amount = 0) and (mode = 'TDS') = (tds_amount > 0)
--     and (mode <> 'TDS' or (for_month is not null and date = private.month_end(date) and private.month_start(for_month) = date_trunc('month', date)::date))));
--   commit;

begin;

do $$
declare
  old_check text;
  n int;
begin
  if exists (select 1 from information_schema.columns where table_schema = 'finance' and table_name = 'payments' and column_name = 'tds_rate')
     or exists (select 1 from pg_constraint where conrelid = 'finance.payments'::regclass and conname = 'payments_station_tds_check') then
    raise exception 'Station payment TDS migration stopped: it is already applied (fully or partly). Nothing was changed.';
  end if;
  -- The constraint to replace: the only CHECK on finance.payments naming both DIESEL_SETTLEMENT and the TDS mode.
  select count(*), min(conname) into n, old_check from pg_constraint
  where conrelid = 'finance.payments'::regclass and contype = 'c'
    and pg_get_constraintdef(oid) like '%DIESEL_SETTLEMENT%' and pg_get_constraintdef(oid) like '%TDS%' and pg_get_constraintdef(oid) like '%tds_amount > %';
  if n <> 1 then
    raise exception 'Station payment TDS migration stopped: expected one station-voucher TDS constraint on finance.payments, found %. Nothing was changed.', n;
  end if;
  execute format('alter table finance.payments drop constraint %I', old_check);
end $$;

alter table finance.payments add column tds_rate numeric(8, 4) check (tds_rate >= 0 and tds_rate < 100);
comment on column finance.payments.tds_rate is 'Fuel station payments with TDS deducted: the TDS % of the total settled (amount + tds_amount). NULL = none.';

alter table finance.payments add constraint payments_station_tds_check check (
  -- tds_rate exists only on station vouchers
  (tds_rate is null or (category_code = 'DIESEL_SETTLEMENT' and mode <> 'TDS'))
  and (category_code is distinct from 'DIESEL_SETTLEMENT' or (
    -- the monthly TDS entry, exactly as before: amount 0, TDS > 0, dated its month's last day, against its own month
    (mode = 'TDS') = (amount = 0)
    and (mode <> 'TDS' or (tds_amount > 0 and for_month is not null and date = private.month_end(date) and private.month_start(for_month) = date_trunc('month', date)::date))
    -- a payment: no TDS (as before), or TDS = round(total settled × % / 100, 2) — the same rounding as the app's round2
    and (mode = 'TDS' or (tds_rate is null and tds_amount = 0) or (tds_rate is not null and tds_amount = round((amount + tds_amount) * tds_rate / 100, 2)))
  ))
);

commit;
