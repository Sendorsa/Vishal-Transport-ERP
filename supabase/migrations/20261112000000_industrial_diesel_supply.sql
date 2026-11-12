-- Industrial Diesel Supply (owner, 12 Nov 2026): diesel supplied to a customer for industrial use (generator,
-- machinery, construction equipment, factory). A customer-level register, separate from vehicle Diesel:
--   * never linked to a vehicle, a fuel station, a tanker or a payment;
--   * nothing that computes vehicle Diesel, KM Run, mileage, AdBlue, station purchases / ledgers or payments reads it.
-- Permissions follow Diesel (the `diesel` resource, core.role_permissions unchanged): Owner, Dev and Employee as for
-- Diesel entries; Tata Adblue / Adblue read only (diesel:view; Tata Adblue its granted customers only). Month lock,
-- archived customer, no future date, an audit event per change (same transaction), exact amount.
-- Additive: one new table with its triggers, policies and grants; no existing table, row or policy is changed.
-- Requires 20261111000200_adblue_profiles.sql (private.customer_in_scope).

create table fuel.industrial_supplies (
  id text primary key default private.new_id('ind'),
  customer_id text not null references core.customers (id),
  date date not null,
  litres numeric(12, 3) not null check (litres > 0),
  rate numeric(12, 4) not null check (rate > 0), -- the rate of this supply, kept for history
  amount numeric(14, 2) generated always as (round(litres * rate, 2)) stored, -- exact, never typed
  purpose text not null check (btrim(purpose) <> '' and btrim(purpose) <> 'Other'), -- "Other" must be described
  remarks text not null default '',
  created_by uuid references public.profiles (id), -- set by industrial_supply_stamp (null for SQL-editor / system writes)
  updated_by uuid references public.profiles (id),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
comment on table fuel.industrial_supplies is 'Industrial Diesel Supply: diesel supplied to a customer for industrial use. Never a vehicle; not part of vehicle Diesel, stock, stations or payments.';
create index industrial_supplies_customer_date_idx on fuel.industrial_supplies (customer_id, date);
create index industrial_supplies_date_idx on fuel.industrial_supplies (date);

-- Who created / last changed it comes from the signed-in profile, never from the request; the customer never changes
-- (an edit doesn't move a supply to another customer); a customer archived on the date takes no new supply.
create function private.industrial_supply_stamp() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform private.assert_not_archived_on(null, new.customer_id, new.date);
    new.created_by := private.current_profile_id();
    new.updated_by := new.created_by;
  else
    if new.customer_id is distinct from old.customer_id then
      raise exception 'An industrial supply can''t be moved to another customer. Delete it and add it again.' using errcode = 'check_violation';
    end if;
    new.created_by := old.created_by;
    new.updated_by := private.current_profile_id();
  end if;
  return new;
end $$;
create trigger industrial_supplies_stamp before insert or update on fuel.industrial_supplies for each row execute function private.industrial_supply_stamp();
create trigger industrial_supplies_no_future before insert or update on fuel.industrial_supplies for each row execute function private.refuse_future_date();
create trigger industrial_supplies_touch before update on fuel.industrial_supplies for each row execute function private.touch_updated_at();
create constraint trigger industrial_supplies_require_audit after insert or update or delete on fuel.industrial_supplies
  deferrable initially deferred for each row execute function private.require_audit_event('id');

-- Grants and RLS (the fuel schema stays off the Data API: /api/erp is the only way in).
revoke all on fuel.industrial_supplies from public, anon, authenticated;
grant select, insert, update, delete on fuel.industrial_supplies to authenticated;
grant all on fuel.industrial_supplies to service_role;
alter table fuel.industrial_supplies enable row level security;
create policy "Read industrial supplies" on fuel.industrial_supplies for select to authenticated
  using ((select private.can('diesel', 'view')) and private.customer_in_scope(customer_id));
create policy "Add industrial supplies" on fuel.industrial_supplies for insert to authenticated
  with check ((select private.can('diesel', 'create')) and private.month_open(date) and private.customer_in_scope(customer_id));
create policy "Edit industrial supplies" on fuel.industrial_supplies for update to authenticated
  using ((select private.can('diesel', 'edit')) and private.month_open(date))
  with check (private.month_open(date));
create policy "Delete industrial supplies" on fuel.industrial_supplies for delete to authenticated
  using ((select private.can('diesel', 'delete')) and private.month_open(date));

revoke all on function private.industrial_supply_stamp() from public, anon, authenticated;
