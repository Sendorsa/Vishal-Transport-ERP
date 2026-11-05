-- Owner's instruction, 5 Nov 2026: the Employee may use Fuel Stations → station → Add Payment and Opening Balance.
-- Mirrors canRecordStationPayment / canSetStationOpening in src/lib/permissions.ts: whoever may edit fuel records
-- (diesel:edit) may record a fuel station payment (never TDS) and a station's opening balance. The Monthly Sheet Lock
-- still applies (private.month_open). core.role_permissions is unchanged: no general payment access is granted —
-- receipts, expenses, TDS, payment edits / deletes stay with payment users. Additive: earlier migrations are not edited.

drop policy "Record payments" on finance.payments;
create policy "Record payments" on finance.payments for insert to authenticated
  with check (
    (
      (select private.can('payments', 'create'))
      or ((select private.can('vehicles', 'edit')) and direction = 'OUT' and vehicle_id is not null)
      or ((select private.can('diesel', 'edit')) and direction = 'OUT' and category_code = 'DIESEL_SETTLEMENT' and station_id is not null and tds_amount = 0)
    )
    and private.month_open(date)
  );

create or replace function private.fuel_station_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.is_tanker_source is distinct from old.is_tanker_source then
    raise exception 'The tanker source can''t be changed.' using errcode = 'check_violation';
  end if;
  if (new.opening_balance, new.opening_balance_date) is distinct from (old.opening_balance, old.opening_balance_date)
     and private.erp_role() is not null then
    if not private.can('diesel', 'edit') then
      raise exception 'Your role can''t record opening balances.' using errcode = 'insufficient_privilege';
    end if;
    if (old.opening_balance_date is not null and not private.month_open(old.opening_balance_date))
       or (new.opening_balance_date is not null and not private.month_open(new.opening_balance_date)) then
      raise exception 'That month is locked. Only the Owner or Dev can change it.' using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end $$;
