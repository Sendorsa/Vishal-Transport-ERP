-- Tyre Data → Tyre (owner, 17 Nov 2026): tyre / repair invoices with their repair lines, and four reusable masters
-- (suppliers, repair types, tyre brands, tyre sizes). Run ONCE in the Supabase Dashboard → SQL Editor as one script.
-- Requires 20261116000000_adblue_vendors_owner_dev_delete.sql (applied to Production, 16 Nov 2026): it uses that
-- migration's delete rule (private.can(…, 'delete') = Owner / Dev) and changes none of its objects. It opens its own
-- transaction: any error — or a guard below — changes nothing. Then run
-- supabase/scripts/production-readonly/10-adblue-vendors-post-apply.sql: every row OK (AdBlue rows and Tyre rows).
--
-- Permissions: a new resource `tyres` (src/lib/permissions.ts): the Owner and Employee get `tyres:*` (Dev holds '*');
-- the AdBlue profiles get nothing. Deleting an invoice: the Owner and Dev only (private.can(…, 'delete'), 16 Nov 2026).
-- Masters are never deleted (archive / restore). Every change needs its audit event in the same transaction; the
-- Monthly Sheet Lock applies to an invoice's date (and its lines through it).
-- Amounts: each line's base, CGST, SGST, IGST and total are GENERATED here — base = round(quantity × rate, 2); GST =
-- round(base × gst_rate / 100, 2), split CGST = round(GST / 2, 2) and SGST = GST − CGST, or IGST = GST; total = base +
-- GST — exactly the app's calculateTax (src/domain/pricing.ts) and lineAmounts (src/domain/tyre.ts). Invoice totals are
-- the sum of its lines, never stored. No payment, voucher or payable is created: the payment fields are information.
-- Additive: new tables, policies and triggers; two permission rows; module_resource gains 'Tyre'. No existing row,
-- table or policy changes. Rollback: drop the three tables and the guard function, delete the two permission rows, and
-- restore module_resource from 20261111000200_adblue_profiles.sql (see the end of this file) — the audit events stay.

begin;

do $$
begin
  if to_regclass('ops.tyre_masters') is not null or to_regclass('ops.tyre_invoices') is not null or to_regclass('ops.tyre_invoice_items') is not null
     or to_regproc('private.tyre_item_delete_guard') is not null or to_regproc('private.tyre_invoice_has_lines') is not null
     or exists (select 1 from core.role_permissions where permission like 'tyres%') then
    raise exception 'Tyre Data migration stopped: it is already applied (fully or partly). Nothing was changed.';
  end if;
  -- The AdBlue vendor migration (20261116000000) must be in: its delete rule, guard functions and vendor table.
  if to_regproc('private.edit_delete_guard') is null or to_regproc('private.is_same_day_undo') is null or to_regclass('fuel.adblue_vendors') is null
     or to_regproc('private.require_parent_audit_event') is null or to_regproc('private.module_resource') is null then
    raise exception 'Tyre Data migration stopped: 20261116000000_adblue_vendors_owner_dev_delete.sql (and the migrations before it) must be applied first. Nothing was changed.';
  end if;
end $$;

/* ------------------------------------------------------------------ masters */

create table ops.tyre_masters (
  id text primary key default private.new_id('tym'),
  kind text not null check (kind in ('SUPPLIER', 'REPAIR_TYPE', 'BRAND', 'SIZE')),
  name text not null check (btrim(name) <> '' and length(name) <= 120),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'ARCHIVED')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (kind, id) -- for the kind-checked foreign keys below
);
comment on table ops.tyre_masters is 'Tyre Data masters: suppliers, repair types, tyre brands, tyre sizes. Never deleted: archived and restored.';
-- One value per name in each list, spaces / case ignored (the app's masterKey: trim, collapse whitespace, lower case).
create unique index tyre_masters_name_key on ops.tyre_masters (kind, lower(btrim(regexp_replace(name, '\s+', ' ', 'g'))));

/* ------------------------------------------------------------------ invoices and their lines */

create table ops.tyre_invoices (
  id text primary key default private.new_id('tyr'),
  date date not null,
  vehicle_id text not null references core.vehicles (id),
  customer_id text references core.customers (id), -- the vehicle's customer on `date` (set by the app); null only for office
  -- "Office / No Customer" (owner, 17 Nov 2026): chosen explicitly for a vehicle with no customer on `date` — no customer
  -- record exists for it; counted in total tyre spend, never in a customer's. Exactly one of the two, always.
  office boolean not null default false check ((office and customer_id is null) or (not office and customer_id is not null)),
  supplier_kind text not null default 'SUPPLIER' check (supplier_kind = 'SUPPLIER'),
  supplier_id text not null,
  bill_no text not null default '',
  purchase_mode text not null default '',
  payment_mode text not null default '',
  payment_details text not null default '',
  remarks text not null default '',
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  foreign key (supplier_kind, supplier_id) references ops.tyre_masters (kind, id)
);
comment on table ops.tyre_invoices is 'Tyre / repair invoices: one supplier bill for one vehicle. Totals = the sum of its lines (ops.tyre_invoice_items).';
create index tyre_invoices_date_idx on ops.tyre_invoices (date);
create index tyre_invoices_vehicle_idx on ops.tyre_invoices (vehicle_id, date);
create index tyre_invoices_customer_idx on ops.tyre_invoices (customer_id, date) where customer_id is not null;
create index tyre_invoices_office_idx on ops.tyre_invoices (date) where office;
create index tyre_invoices_supplier_idx on ops.tyre_invoices (supplier_id, date);
create index tyre_invoices_bill_idx on ops.tyre_invoices (lower(bill_no)) where bill_no <> '';

create table ops.tyre_invoice_items (
  id text primary key default private.new_id('tyi'),
  invoice_id text not null references ops.tyre_invoices (id) on delete cascade, -- deleting an invoice (Owner / Dev) takes its lines
  line_no int not null check (line_no >= 0),
  repair_type_kind text not null default 'REPAIR_TYPE' check (repair_type_kind = 'REPAIR_TYPE'),
  repair_type_id text not null,
  brand_kind text not null default 'BRAND' check (brand_kind = 'BRAND'),
  brand_id text,
  size_kind text not null default 'SIZE' check (size_kind = 'SIZE'),
  size_id text,
  tyre_number text not null default '',
  opening_km numeric check (opening_km >= 0),
  closing_km numeric check (closing_km >= 0),
  quantity numeric(12, 3) not null check (quantity > 0),
  rate numeric(14, 2) not null check (rate >= 0),
  gst_rate numeric(5, 2) not null default 0 check (gst_rate >= 0 and gst_rate <= 100),
  tax_type text not null default 'CGST_SGST' check (tax_type in ('CGST_SGST', 'IGST')),
  base_value numeric(14, 2) generated always as (round(quantity * rate, 2)) stored,
  cgst numeric(14, 2) generated always as (case when tax_type = 'CGST_SGST' then round(round(round(quantity * rate, 2) * gst_rate / 100, 2) / 2, 2) else 0 end) stored,
  sgst numeric(14, 2) generated always as (case when tax_type = 'CGST_SGST' then round(round(quantity * rate, 2) * gst_rate / 100, 2) - round(round(round(quantity * rate, 2) * gst_rate / 100, 2) / 2, 2) else 0 end) stored,
  igst numeric(14, 2) generated always as (case when tax_type = 'IGST' then round(round(quantity * rate, 2) * gst_rate / 100, 2) else 0 end) stored,
  total_value numeric(14, 2) generated always as (round(quantity * rate, 2) + round(round(quantity * rate, 2) * gst_rate / 100, 2)) stored,
  removing_number text not null default '',
  remarks text not null default '',
  check (opening_km is null or closing_km is null or closing_km >= opening_km),
  unique (invoice_id, line_no) deferrable initially deferred, -- lines can be renumbered within one edit
  foreign key (repair_type_kind, repair_type_id) references ops.tyre_masters (kind, id),
  foreign key (brand_kind, brand_id) references ops.tyre_masters (kind, id),
  foreign key (size_kind, size_id) references ops.tyre_masters (kind, id)
);
comment on table ops.tyre_invoice_items is 'Repair lines of a tyre invoice. Amounts are generated: base = quantity × rate; GST split CGST + SGST or IGST.';
create index tyre_invoice_items_repair_idx on ops.tyre_invoice_items (repair_type_id);
create index tyre_invoice_items_brand_idx on ops.tyre_invoice_items (brand_id) where brand_id is not null;
create index tyre_invoice_items_size_idx on ops.tyre_invoice_items (size_id) where size_id is not null;

-- Every invoice has at least one line (checked at COMMIT, so a new invoice and its lines are written together).
create function private.tyre_invoice_has_lines() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  inv text;
begin
  if tg_table_name = 'tyre_invoices' then
    inv := new.id;
  elsif tg_op = 'DELETE' then
    inv := old.invoice_id;
  else
    inv := new.invoice_id;
  end if;
  if exists (select 1 from ops.tyre_invoices i where i.id = inv) and not exists (select 1 from ops.tyre_invoice_items t where t.invoice_id = inv) then
    raise exception 'A tyre invoice needs at least one repair line (invoice %).', inv using errcode = 'check_violation';
  end if;
  return null;
end $$;
revoke all on function private.tyre_invoice_has_lines() from public, anon, authenticated;
create constraint trigger tyre_invoices_has_lines after insert or update on ops.tyre_invoices
  deferrable initially deferred for each row execute function private.tyre_invoice_has_lines();
create constraint trigger tyre_invoice_items_has_lines after delete or update on ops.tyre_invoice_items
  deferrable initially deferred for each row execute function private.tyre_invoice_has_lines();

/* ------------------------------------------------------------------ audit: no change without its event */

create trigger tyre_masters_touch before update on ops.tyre_masters for each row execute function private.touch_updated_at();
create trigger tyre_invoices_touch before update on ops.tyre_invoices for each row execute function private.touch_updated_at();
create constraint trigger tyre_masters_require_audit after insert or update or delete on ops.tyre_masters
  deferrable initially deferred for each row execute function private.require_audit_event('id');
create constraint trigger tyre_invoices_require_audit after insert or update or delete on ops.tyre_invoices
  deferrable initially deferred for each row execute function private.require_audit_event('id');
-- A line changes only with its invoice's event (CREATED / UPDATED / DELETED / RESTORED of the invoice).
create constraint trigger tyre_invoice_items_require_audit after insert or update or delete on ops.tyre_invoice_items
  deferrable initially deferred for each row execute function private.require_parent_audit_event('invoice_id');

-- Delete = Owner / Dev (16 Nov 2026): any other role removes a line only inside its invoice's audited edit, whose
-- "before" snapshot records that line (as private.edit_delete_guard does for the other child rows).
create function private.tyre_item_delete_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.erp_role() is null or private.can('tyres', 'delete') then
    return null;
  end if;
  if not exists (
    select 1 from audit.events e
    where e.txid = txid_current() and e.record_id = old.invoice_id and e.action in ('UPDATED')
      and e.after is not null and e.before @> jsonb_build_object('items', jsonb_build_array(jsonb_build_object('id', old.id)))
  ) then
    raise exception 'Only the Owner and Dev can delete records: a tyre invoice line (invoice %) is removed only by an audited edit of its invoice.', old.invoice_id
      using errcode = 'insufficient_privilege';
  end if;
  return null;
end $$;
revoke all on function private.tyre_item_delete_guard() from public, anon, authenticated;
create constraint trigger tyre_invoice_items_edit_delete after delete on ops.tyre_invoice_items
  deferrable initially deferred for each row execute function private.tyre_item_delete_guard();

/* ------------------------------------------------------------------ permissions, grants and RLS */

insert into core.role_permissions (role, permission) values ('OWNER', 'tyres:*'), ('EMPLOYEE', 'tyres:*'); -- DEV holds '*'

-- Audit history, record history and the 20-second change polling map the module to its permission.
create or replace function private.module_resource(module text) returns text
language sql immutable set search_path = '' as $$
  select case module
    when 'Diesel' then 'diesel' when 'AdBlue' then 'adblue' when 'Diesel Tanker' then 'diesel' when 'Fuel Stations' then 'diesel'
    when 'Payments' then 'payments' when 'Customers' then 'customers' when 'Vehicles' then 'vehicles'
    when 'Drivers' then 'settings' when 'Trips' then 'trips' when 'Invoices' then 'invoices' when 'Settings' then 'settings'
    when 'Tyre' then 'tyres'
    else 'audit' end
$$;

revoke all on ops.tyre_masters, ops.tyre_invoices, ops.tyre_invoice_items from public, anon, authenticated;
grant all on ops.tyre_masters, ops.tyre_invoices, ops.tyre_invoice_items to service_role;
grant select, insert, update on ops.tyre_masters to authenticated; -- no delete: archive
grant select, insert, update, delete on ops.tyre_invoices, ops.tyre_invoice_items to authenticated;
alter table ops.tyre_masters enable row level security;
alter table ops.tyre_invoices enable row level security;
alter table ops.tyre_invoice_items enable row level security;

create policy "Read tyre masters" on ops.tyre_masters for select to authenticated using ((select private.can('tyres', 'view')));
create policy "Add tyre masters" on ops.tyre_masters for insert to authenticated with check ((select private.can('tyres', 'create')));
create policy "Edit tyre masters" on ops.tyre_masters for update to authenticated
  using ((select private.can('tyres', 'edit'))) with check ((select private.can('tyres', 'edit')));

create policy "Read tyre invoices" on ops.tyre_invoices for select to authenticated using ((select private.can('tyres', 'view')));
create policy "Add tyre invoices" on ops.tyre_invoices for insert to authenticated
  with check ((select private.can('tyres', 'create')) and private.month_open(date));
create policy "Edit tyre invoices" on ops.tyre_invoices for update to authenticated
  using ((select private.can('tyres', 'edit')) and private.month_open(date))
  with check ((select private.can('tyres', 'edit')) and private.month_open(date));
create policy "Delete tyre invoices" on ops.tyre_invoices for delete to authenticated
  using ((select private.can('tyres', 'delete')) and private.month_open(date));

-- Lines follow their invoice's month (an edit that moves the invoice's date is checked on both months).
create policy "Read tyre invoice lines" on ops.tyre_invoice_items for select to authenticated using ((select private.can('tyres', 'view')));
create policy "Add tyre invoice lines" on ops.tyre_invoice_items for insert to authenticated
  with check (((select private.can('tyres', 'create')) or (select private.can('tyres', 'edit')))
              and exists (select 1 from ops.tyre_invoices i where i.id = invoice_id and private.month_open(i.date)));
create policy "Edit tyre invoice lines" on ops.tyre_invoice_items for update to authenticated
  using ((select private.can('tyres', 'edit')) and exists (select 1 from ops.tyre_invoices i where i.id = invoice_id and private.month_open(i.date)))
  with check ((select private.can('tyres', 'edit')) and exists (select 1 from ops.tyre_invoices i where i.id = invoice_id and private.month_open(i.date)));
create policy "Delete tyre invoice lines" on ops.tyre_invoice_items for delete to authenticated
  using (((select private.can('tyres', 'delete')) or (select private.can('tyres', 'edit')))
         and exists (select 1 from ops.tyre_invoices i where i.id = invoice_id and private.month_open(i.date)));

/* ------------------------------------------------------------------ the starting repair types (2026–27 tyre register) */

-- Written once each as the owner listed them; spelling variants and combined descriptions in the register are NOT
-- merged or split. More are added from the invoice form. Each with its SYSTEM audit event.
with added as (
  insert into ops.tyre_masters (kind, name)
  select 'REPAIR_TYPE', n from unnest(array['New Tyre Purchased', 'Rebuilt Tyres', 'Wheel Alignment', 'Wheel Alignment Charge', 'Wheel Tyre Fitting',
    'Tyre Fitting', 'Wheel Rotation Work', 'Puncture Work', 'Tube', 'Flap', 'Wheel Balancing', 'Wheel Balance / Weights']) with ordinality as t(n, o)
  order by o
  returning *
)
insert into audit.events (actor_kind, action, module, record_type, record_id, label, after, note)
select 'SYSTEM', 'CREATED', 'Tyre', 'Repair type', a.id, a.name, to_jsonb(a), 'Starting repair types from the 2026–27 tyre register (17 Nov 2026)'
from added a;

commit;

/* ------------------------------------------------------------------ rollback (manual, reviewed; not part of the migration)
-- Deploy the app version without Tyre Data first. Then, in one transaction (DESTROYS every tyre invoice and master —
-- export them first; their audit events stay):
--   begin;
--   drop table ops.tyre_invoice_items; drop table ops.tyre_invoices; drop table ops.tyre_masters;
--   drop function private.tyre_item_delete_guard(); drop function private.tyre_invoice_has_lines();
--   delete from core.role_permissions where permission = 'tyres:*';
--   -- private.module_resource as in 20261111000200_adblue_profiles.sql (without the 'Tyre' line)
--   commit;
*/
