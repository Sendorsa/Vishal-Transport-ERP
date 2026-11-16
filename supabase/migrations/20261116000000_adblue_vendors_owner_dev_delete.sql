-- Owner's instruction, 16 Nov 2026 (revised after review, 16 Nov 2026). Run in the Supabase Dashboard → SQL Editor as
-- ONE script, after supabase/scripts/production-readonly/09-adblue-vendors-preflight.sql shows no STOP.
-- Requires 20261111000200_adblue_profiles.sql and 20261112000100_industrial_tanker_allocations.sql.
--
-- ATOMIC: the script opens its own transaction (BEGIN … COMMIT below) instead of relying on how the SQL Editor sends
-- it. Any error — including every guard below (RAISE) — aborts the transaction: nothing is changed, and the editor
-- shows the guard's message. Deploy the matching app version straight after COMMIT (see "Deployment window" below).
--
-- 1. Deleting any record: the OWNER and DEV only. private.can(resource, 'delete') is refused to every other role, so
--    every business "Delete …" RLS policy (diesel entries, tanker loads / transfers / adjustments, AdBlue entries and
--    purchases, industrial supplies, payments, payment allocations, trips) and the audit rule "no DELETED event without
--    the right to delete" follow without being rewritten. Mirrors can() / canDelete in src/lib/permissions.ts. No
--    permission row is changed. Child rows that an EDIT removes (1b): vehicle assignments and customer prices become
--    Owner / Dev only (no edit removes them); status periods, route rates and industrial tanker allocations are removed by
--    any other role only inside the parent's audited edit, whose "before" snapshot records them (edit_delete_guard).
-- 2. The AdBlue vendor master (fuel.adblue_vendors): archived, never deleted. Purchases and vehicle AdBlue entries name
--    their vendor (vendor_id). Costing is FIFO per vendor, calculated in the app (src/domain/adblue-inventory.ts).
-- 3. Backfill (owner-approved, 16 Nov 2026): one vendor per distinct purchase vendor name (spaces / case ignored), and
--    every existing bulk purchase linked to it. Only vendor_id is set: no litres, amount, date or name changes. Each new
--    vendor and each linked purchase gets a SYSTEM audit event in this transaction. A purchase without a usable vendor
--    name stops the migration (guard 0) — nothing is guessed.
-- 4. Historical vehicle draws are NOT given a vendor (no source evidence). Every entry that exists now is marked
--    before_vendor_tracking = true, so the app can tell them from new draws. How their stock reconciles (the app,
--    src/domain/adblue-inventory.ts, "Old draws"): an old draw made while only ONE source held stock took that source's
--    stock (the records leave no other possibility); one made while TWO OR MORE sources held stock has an unknown source,
--    so all the stock on hand at that moment becomes "Unattributed stock (no vendor)" and the draw takes it. Litres and
--    value are only relabelled, never created or removed: Σ every vendor's stock + unattributed stock = company stock,
--    and every old litre is consumed once. New draws name a vendor, or draw unattributed stock explicitly.
--
-- One new table, three new columns, one view column added at the end, two functions replaced, one guard function with
-- four triggers, six DELETE policies tightened (no grant changed, no policy loosened). Existing
-- purchases get vendor_id (audited); no other existing row changes (the new flag is a column default, not an UPDATE).
-- Deployment window: between COMMIT and the new app going live, the old app can't save a bulk purchase (the database
-- now requires its vendor) and the Employee can't delete; everything else works. Draws it saves are marked
-- before_vendor_tracking (the column default) — true: it recorded no vendor.
-- Rollback: supabase/scripts/07-rollback-adblue-vendors.sql (deploy the previous app version first).

begin;

/* ------------------------------------------------------------------ 0. guards: stop before changing anything */

do $$
declare
  n int;
  ids text;
begin
  if to_regclass('fuel.adblue_vendors') is not null or to_regproc('private.edit_delete_guard') is not null or to_regproc('private.is_same_day_undo') is not null
     or exists (select 1 from information_schema.columns where table_schema = 'fuel' and table_name in ('adblue_purchases', 'adblue_entries') and column_name in ('vendor_id', 'before_vendor_tracking')) then
    raise exception 'AdBlue vendor migration stopped: it is already applied (fully or partly) — fuel.adblue_vendors or a vendor column exists. Nothing was changed.';
  end if;
  if to_regproc('private.customer_in_scope') is null or to_regclass('fuel.industrial_supply_allocations') is null then
    raise exception 'AdBlue vendor migration stopped: apply 20261111000200_adblue_profiles.sql and 20261112000100_industrial_tanker_allocations.sql first. Nothing was changed.';
  end if;
  -- Every bulk purchase must have a vendor name to be linked by (the table already refuses an empty one; this also
  -- catches names made only of tabs / line breaks).
  select count(*), string_agg(id || ' (' || date || ', ' || total_litres || ' L)', '; ' order by date, id collate "C") into n, ids
  from fuel.adblue_purchases where not opening and btrim(regexp_replace(coalesce(vendor_name, ''), '\s+', ' ', 'g')) = '';
  if n > 0 then
    raise exception 'AdBlue vendor migration stopped: % bulk purchase(s) have no vendor name: %. Enter each one''s vendor in the app (AdBlue → Purchase history → Edit), then run this script again. Nothing was changed.', n, ids;
  end if;
end $$;

/* ------------------------------------------------------------------ 1. delete = Owner and Dev */

create or replace function private.can(resource text, action text default 'view') returns boolean
language sql stable security definer set search_path = '' as $$
  select (resource not in ('accounts', 'system') or private.erp_role() = 'DEV')
    and (action <> 'delete' or coalesce(private.erp_role() in ('OWNER', 'DEV'), false))
    and exists (
      select 1 from core.role_permissions rp
      where rp.role = private.erp_role() and rp.permission in ('*', resource || ':*', resource || ':' || action)
    )
$$;

/* ------------------------------------------------------------------ 1b. rows an edit removes: never a standalone delete */

-- Owner's rule, strictly: only the OWNER and DEV delete. Six DELETE policies allowed `edit` because an edit removes
-- child rows. What the app really removes (src/lib/server/erp/tables.ts), always inside an audited edit of the parent:
--   * a customer's / vehicle's status period: only a same-day undo — archive then restore (or a status change and back)
--     today removes the latest period, which started today (appendPeriod), in the parent's ARCHIVED / RESTORED /
--     UPDATED transaction;
--   * a customer's route rates: rewritten by a customer edit (UPDATED);
--   * an industrial supply's tanker allocations: rewritten by a supply edit (UPDATED); a deleted supply takes them along
--     (cascade — the supply delete itself is Owner / Dev only);
--   * vehicle assignments and customer prices: never (a transfer closes and appends; prices are upserted).
-- So: assignments and prices → delete = Owner / Dev only. Status periods → besides the Owner / Dev, only the entity's
-- latest period, started today. And for every other role, edit_delete_guard (checked at COMMIT, like every audit rule)
-- requires the parent's edit event in the same transaction whose `before` snapshot records the removed row: a child
-- row never disappears on its own, and the audit trail always shows what it was. The SQL editor (no ERP session) is
-- not limited here — RLS does not apply to it either.
drop policy "Undo assignments" on core.vehicle_assignments;
create policy "Delete assignments" on core.vehicle_assignments for delete to authenticated
  using ((select private.can('vehicles', 'delete')) and private.month_open(start_date));

drop policy "Write pricing" on core.customer_pricing;
create policy "Add pricing" on core.customer_pricing for insert to authenticated
  with check ((select private.can('customers', 'edit')) or (select private.can('customers', 'create')));
create policy "Edit pricing" on core.customer_pricing for update to authenticated
  using ((select private.can('customers', 'edit')) or (select private.can('customers', 'create')))
  with check ((select private.can('customers', 'edit')) or (select private.can('customers', 'create')));
create policy "Delete pricing" on core.customer_pricing for delete to authenticated using ((select private.can('customers', 'delete')));

-- A same-day undo: the customer's / vehicle's latest status period, started today, with an earlier one to reopen (an
-- undo never leaves a record without history). A function: a policy can't read its own table.
create function private.is_same_day_undo(p_kind text, p_entity text, p_start date) returns boolean
language sql stable security definer set search_path = '' as $$
  with p as (
    select start_date from core.customer_status_periods where p_kind = 'customer' and customer_id = p_entity
    union all
    select start_date from core.vehicle_status_periods where p_kind = 'vehicle' and vehicle_id = p_entity
  )
  select p_start >= private.today_ist()
     and not exists (select 1 from p where start_date > p_start)
     and exists (select 1 from p where start_date < p_start)
$$;
revoke all on function private.is_same_day_undo(text, text, date) from public, anon;
grant execute on function private.is_same_day_undo(text, text, date) to authenticated, service_role; -- called by the policies

drop policy "Undo customer status" on core.customer_status_periods;
create policy "Undo customer status" on core.customer_status_periods for delete to authenticated
  using ((select private.can('customers', 'delete'))
         or ((select private.can('customers', 'edit')) and private.is_same_day_undo('customer', customer_id, start_date)));
drop policy "Undo vehicle status" on core.vehicle_status_periods;
create policy "Undo vehicle status" on core.vehicle_status_periods for delete to authenticated
  using ((select private.can('vehicles', 'delete'))
         or ((select private.can('vehicles', 'edit')) and private.is_same_day_undo('vehicle', vehicle_id, start_date)));

create function private.edit_delete_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  o jsonb := to_jsonb(old);
  parent text;
  resource text;
  recorded jsonb; -- how the removed row appears in the parent's audit snapshot (src/lib/types.ts field names)
begin
  case tg_table_name
    when 'customer_status_periods' then
      parent := o ->> 'customer_id'; resource := 'customers';
      recorded := jsonb_build_object('statusHistory', jsonb_build_array(jsonb_build_object('status', o -> 'status', 'startDate', o -> 'start_date')));
    when 'vehicle_status_periods' then
      parent := o ->> 'vehicle_id'; resource := 'vehicles';
      recorded := jsonb_build_object('statusHistory', jsonb_build_array(jsonb_build_object('status', o -> 'status', 'startDate', o -> 'start_date')));
    when 'customer_route_rates' then
      parent := o ->> 'customer_id'; resource := 'customers';
      recorded := jsonb_build_object('pricing', jsonb_build_object('routes', jsonb_build_array(jsonb_build_object('route', o -> 'route'))));
    when 'industrial_supply_allocations' then
      parent := o ->> 'supply_id'; resource := 'diesel';
      recorded := jsonb_build_object('allocations', jsonb_build_array(jsonb_build_object('tankerId', o -> 'tanker_id')));
  end case;
  if private.erp_role() is null or private.can(resource, 'delete') then
    return null;
  end if;
  if not exists (
    select 1 from audit.events e
    where e.txid = txid_current() and e.record_id = parent and e.action in ('UPDATED', 'ARCHIVED', 'RESTORED')
      and e.after is not null and e.before @> recorded
  ) then
    raise exception 'Only the Owner and Dev can delete records: a %.% row (record %) is removed only by an audited edit of its record.', tg_table_schema, tg_table_name, parent
      using errcode = 'insufficient_privilege';
  end if;
  return null;
end $$;
revoke all on function private.edit_delete_guard() from public, anon, authenticated;

create constraint trigger customer_status_periods_edit_delete after delete on core.customer_status_periods
  deferrable initially deferred for each row execute function private.edit_delete_guard();
create constraint trigger vehicle_status_periods_edit_delete after delete on core.vehicle_status_periods
  deferrable initially deferred for each row execute function private.edit_delete_guard();
create constraint trigger customer_route_rates_edit_delete after delete on core.customer_route_rates
  deferrable initially deferred for each row execute function private.edit_delete_guard();
create constraint trigger industrial_supply_allocations_edit_delete after delete on fuel.industrial_supply_allocations
  deferrable initially deferred for each row execute function private.edit_delete_guard();

/* ------------------------------------------------------------------ 2. AdBlue vendor master */

-- Vendor names compare with spaces collapsed and case ignored — the same key as the app (vendorKeyOf: trim, collapse
-- whitespace, lower case).
create table fuel.adblue_vendors (
  id text primary key default private.new_id('adv'),
  name text not null check (btrim(name) <> ''),
  default_rate numeric(12, 4) check (default_rate > 0), -- pre-fills a purchase only; each purchase keeps its own rate
  contact_person text not null default '',
  phone text not null default '',
  notes text not null default '',
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'ARCHIVED')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
comment on table fuel.adblue_vendors is 'AdBlue vendors (bulk and direct purchases). Never deleted: archived and restored.';
create unique index adblue_vendors_name_key on fuel.adblue_vendors (lower(btrim(regexp_replace(name, '\s+', ' ', 'g'))));

create trigger adblue_vendors_touch before update on fuel.adblue_vendors for each row execute function private.touch_updated_at();
create constraint trigger adblue_vendors_require_audit after insert or update or delete on fuel.adblue_vendors
  deferrable initially deferred for each row execute function private.require_audit_event('id');

alter table fuel.adblue_purchases add column vendor_id text references fuel.adblue_vendors (id);
alter table fuel.adblue_entries add column vendor_id text references fuel.adblue_vendors (id);
create index adblue_purchases_vendor_idx on fuel.adblue_purchases (vendor_id);
create index adblue_entries_vendor_idx on fuel.adblue_entries (vendor_id);

-- Every entry that exists now was recorded before vendor tracking. A column default fills them (PostgreSQL stores the
-- default once; no row is updated, no trigger fires, updated_at is untouched). The default stays true: the app writes
-- false on every new entry, so only a write that knows nothing of vendors (the old app during the deployment window,
-- the SQL editor) is marked as recording no vendor — which is what it did.
alter table fuel.adblue_entries add column before_vendor_tracking boolean not null default true;
comment on column fuel.adblue_entries.before_vendor_tracking is
  'True: recorded without vendor tracking (every entry before 16 Nov 2026). Its vendor is never guessed; the app decides from the stock on hand at the time (src/domain/adblue-inventory.ts). The app writes false on every new entry.';

revoke all on fuel.adblue_vendors from public, anon, authenticated;
grant select, insert, update on fuel.adblue_vendors to authenticated; -- no delete: archive
grant all on fuel.adblue_vendors to service_role;
alter table fuel.adblue_vendors enable row level security;
create policy "Read AdBlue vendors" on fuel.adblue_vendors for select to authenticated using ((select private.can('adblue', 'view')));
-- Master data: the Owner, Dev and Employee (is_owner_or_dev). The AdBlue profiles pick existing vendors only.
create policy "Add AdBlue vendors" on fuel.adblue_vendors for insert to authenticated
  with check ((select private.can('adblue', 'create')) and (select private.is_owner_or_dev()));
create policy "Edit AdBlue vendors" on fuel.adblue_vendors for update to authenticated
  using ((select private.can('adblue', 'edit')) and (select private.is_owner_or_dev()));

/* ------------------------------------------------------------------ 3. backfill: existing purchases → their vendor */

-- One vendor per normalised name; it is named by the earliest purchase's spelling (whitespace collapsed).
with names as (
  select distinct on (lower(btrim(regexp_replace(vendor_name, '\s+', ' ', 'g'))))
         btrim(regexp_replace(vendor_name, '\s+', ' ', 'g')) as name
  from fuel.adblue_purchases where not opening
  order by lower(btrim(regexp_replace(vendor_name, '\s+', ' ', 'g'))), date, created_at, id collate "C"
), added as (
  insert into fuel.adblue_vendors (name) select name from names returning *
)
insert into audit.events (actor_kind, action, module, record_type, record_id, label, after, note)
select 'SYSTEM', 'CREATED', 'AdBlue', 'AdBlue vendor', a.id, a.name, to_jsonb(a), 'Vendor master created from existing AdBlue purchases (16 Nov 2026)'
from added a;

with linked as (
  update fuel.adblue_purchases p set vendor_id = v.id
  from fuel.adblue_vendors v
  where not p.opening and p.vendor_id is null
    and lower(btrim(regexp_replace(p.vendor_name, '\s+', ' ', 'g'))) = lower(btrim(regexp_replace(v.name, '\s+', ' ', 'g')))
  returning p.*
)
insert into audit.events (actor_kind, action, module, record_type, record_id, label, record_date, after, changes, note)
select 'SYSTEM', 'UPDATED', 'AdBlue', 'AdBlue purchase', l.id, l.vendor_name, l.date, to_jsonb(l),
  jsonb_build_array(jsonb_build_object('field', 'adblueVendorId', 'before', null, 'after', l.vendor_id)),
  'Linked to its vendor in the AdBlue vendor master (16 Nov 2026); litres, amount and date unchanged'
from linked l;

-- Every bulk purchase is linked, once, with its event — or nothing is changed.
do $$
declare
  n int;
  ids text;
begin
  select count(*), string_agg(id, ', ' order by id collate "C") into n, ids from fuel.adblue_purchases where not opening and vendor_id is null;
  if n > 0 then
    raise exception 'AdBlue vendor migration stopped: % bulk purchase(s) could not be linked to a vendor: %. Nothing was changed.', n, ids;
  end if;
  if (select count(*) from fuel.adblue_purchases where vendor_id is not null)
     <> (select count(*) from audit.events where module = 'AdBlue' and record_type = 'AdBlue purchase' and actor_kind = 'SYSTEM' and txid = txid_current()) then
    raise exception 'AdBlue vendor migration stopped: the purchase links and their audit events differ. Nothing was changed.';
  end if;
end $$;

-- Run the backfill's deferred checks now instead of at COMMIT (every change has its audit event; stock never below
-- zero): ALTER TABLE below can't run while they are pending. A failure here aborts everything, as at COMMIT.
set constraints all immediate;

-- Every purchase names its vendor from now on (opening stock has none).
alter table fuel.adblue_purchases add constraint adblue_purchases_vendor_id_check check (opening or vendor_id is not null);

/* ------------------------------------------------------------------ 4. stock: never below zero, also per vendor */

-- The same movements, plus the vendor (added at the end: create or replace view keeps the existing columns).
create or replace view fuel.adblue_stock_movements with (security_invoker = true) as
  select id, date, created_at, 0 as sort_rank, total_litres as litres, vendor_id from fuel.adblue_purchases
  union all
  select id, date, created_at, 1, -quantity_litres, vendor_id from fuel.adblue_entries where source = 'STOCK';

-- Company stock never below zero (exact, as before), and a draw naming a vendor never takes more than that vendor
-- bought minus its vendor-named draws.
-- ponytail: the per-vendor sum is an upper bound of the vendor's real stock (old draws and stock that became
-- unattributed lower it further, in the app), so it never refuses a valid draw but may let an invalid one through —
-- the API runs the exact check (assertStock) under the same advisory lock before anything is written, and /api/erp is
-- the only way in. Exact per-vendor FIFO in SQL if writes ever bypass the API.
create or replace function private.adblue_shortfall() returns table (available numeric, needed numeric, on_date date)
language sql stable security definer set search_path = '' as $$
  with m as (
    select date, sort_rank, created_at, id, litres, vendor_id,
           sum(litres) over (order by date, sort_rank, created_at, id collate "C" rows between unbounded preceding and current row) as running,
           sum(litres) over (partition by vendor_id order by date, sort_rank, created_at, id collate "C" rows between unbounded preceding and current row) as vendor_running
    from fuel.adblue_stock_movements
  )
  select available, needed, on_date from (
    select running - litres as available, -litres as needed, date as on_date from m where running < 0
    union all
    select vendor_running - litres, -litres, date from m where vendor_id is not null and vendor_running < 0
  ) s order by on_date limit 1
$$;

revoke all on function private.adblue_shortfall() from public, anon;

commit;
