-- AdBlue → supplier credit and payments (owner, 18 Nov 2026). Run ONCE in the Supabase Dashboard → SQL Editor as one
-- script, after 20261116000000_adblue_vendors_owner_dev_delete.sql (applied to Production 16 Nov 2026 — none of its
-- objects or data change here). First supabase/scripts/production-readonly/15-adblue-payments-preflight.sql (read-only:
-- every CHECK row OK), afterwards 16-adblue-payments-post-apply.sql (read-only: every CHECK row OK). It opens its own
-- transaction: any error — or a guard below — changes nothing.
--
-- Money owed to AdBlue vendors, kept apart from stock (src/domain/adblue-payments.ts — the same figures everywhere):
--   purchase value   = total_cost (buckets × price per bucket — what FIFO costs stock at; unchanged) + gst_amount
--   gst_amount       = round(total_cost × gst_rate / 100, 2)    (new; every existing purchase: 0 % → value = total_cost)
--   purchase paid    = Σ its allocations;  outstanding = value − paid
--   payment settled  = amount (paid to the vendor: the cash / bank outflow) + tds_amount;  advance = settled − Σ allocations
--   vendor balance   = Σ purchase values − Σ settled = Σ outstanding − Σ advance
-- Payments never touch stock: no stock function, trigger or column reads these tables. TDS is counted once (inside
-- settled); there is no monthly AdBlue TDS entry, so the same purchases are never taxed twice.
--
-- Rules enforced here (the API checks them first, with clearer messages):
--   • a payment is money paid: amount > 0, a mode (Cash / UPI / NEFT / RTGS / IMPS / Cheque — never Credit), a reference
--     (UTR / cheque / receipt number), not dated in the future; one reference on one payment (spaces / case ignored);
--     TDS = round(settled × % / 100, 2) or none;
--   • allocations go to the payment's own vendor's purchases (never opening stock); Σ allocations ≤ what the payment
--     settles; a purchase is never paid beyond its value — also after a purchase edit (checked at COMMIT, rows locked);
--   • who: the Owner, Dev and Employee read, record and edit (private.is_owner_or_dev() — the AdBlue profiles hold
--     adblue:* for stock only and see no payment); delete — permanent, with its DELETED audit event — the Owner / Dev
--     only (private.can(…, 'delete')); a payment's allocations go with it (on delete cascade); a purchase with
--     allocations can't be deleted (foreign key); an edit may rewrite allocations only inside the payment's audited
--     UPDATED event (adblue_allocation_delete_guard);
--   • the Monthly Sheet Lock applies to the payment's date and to each allocated purchase's date.
-- Additive: two columns on fuel.adblue_purchases (no row's existing value changes), two new tables with their
-- functions, triggers, grants and policies. No payment is created for any existing purchase: every one stays
-- outstanding until a real payment is recorded. Rollback: see the end of this file.

begin;

do $$
begin
  if to_regclass('fuel.adblue_vendors') is null or to_regprocedure('private.edit_delete_guard()') is null
     or not exists (select 1 from information_schema.columns where table_schema = 'fuel' and table_name = 'adblue_purchases' and column_name = 'vendor_id') then
    raise exception 'AdBlue payments migration stopped: 20261116000000_adblue_vendors_owner_dev_delete.sql must be applied first. Nothing was changed.';
  end if;
  if to_regclass('fuel.adblue_payments') is not null or to_regclass('fuel.adblue_payment_allocations') is not null
     or exists (select 1 from information_schema.columns where table_schema = 'fuel' and table_name = 'adblue_purchases' and column_name in ('gst_rate', 'gst_amount'))
     or to_regprocedure('private.adblue_payment_check()') is not null then
    raise exception 'AdBlue payments migration stopped: it is already applied (fully or partly). Nothing was changed.';
  end if;
  if to_regprocedure('private.is_owner_or_dev()') is null or to_regprocedure('private.month_open(date)') is null or to_regprocedure('private.refuse_future_date()') is null
     or to_regprocedure('private.require_audit_event()') is null or to_regprocedure('private.require_parent_audit_event()') is null then
    raise exception 'AdBlue payments migration stopped: a helper function it uses is missing. Nothing was changed.';
  end if;
end $$;

/* ------------------------------------------------------------------ GST on bulk purchases */

-- total_cost (taxable) is unchanged and still all FIFO / Inventory Value use; GST is only owed to the vendor.
alter table fuel.adblue_purchases
  add column gst_rate numeric(5, 2) not null default 0 check (gst_rate >= 0 and gst_rate <= 100),
  add column gst_amount numeric(14, 2) generated always as (round(round(buckets * price_per_bucket, 2) * gst_rate / 100, 2)) stored;
comment on column fuel.adblue_purchases.gst_rate is 'GST % on total_cost. Purchase value owed to the vendor = total_cost + gst_amount; stock is costed at total_cost.';

/* ------------------------------------------------------------------ payments and allocations */

create table fuel.adblue_payments (
  id text primary key default private.new_id('abp'),
  date date not null, -- the day the money was paid
  vendor_id text not null references fuel.adblue_vendors (id),
  amount numeric(14, 2) not null check (amount > 0), -- paid to the vendor (cash / bank outflow)
  tds_rate numeric(8, 4) check (tds_rate >= 0 and tds_rate < 100),
  tds_amount numeric(14, 2) not null default 0 check (tds_amount >= 0),
  mode text not null check (mode in ('Cash', 'UPI', 'NEFT', 'RTGS', 'IMPS', 'Cheque')), -- never Credit: Credit is no payment
  utr text not null check (btrim(utr) <> '' and length(utr) <= 120), -- UTR / cheque number / receipt number
  company_code text references core.companies (code), -- paid by (VT / VTHPL), when recorded
  notes text not null default '',
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint adblue_payments_tds_check check (
    (tds_rate is null and tds_amount = 0) or (tds_rate is not null and tds_amount = round((amount + tds_amount) * tds_rate / 100, 2))
  )
);
comment on table fuel.adblue_payments is 'Payments to AdBlue vendors. Settled = amount + tds_amount; advance = settled − Σ allocations. Never stock.';
create index adblue_payments_vendor_idx on fuel.adblue_payments (vendor_id, date);
-- One reference on one payment — spaces and case ignored (the app's refKey).
create unique index adblue_payments_utr_key on fuel.adblue_payments (lower(regexp_replace(utr, '\s+', '', 'g')));

create table fuel.adblue_payment_allocations (
  id text primary key default private.new_id('apa'),
  payment_id text not null references fuel.adblue_payments (id) on delete cascade, -- deleted with its payment
  line_no int not null check (line_no >= 0),
  purchase_id text not null references fuel.adblue_purchases (id), -- a purchase with payments can't be deleted
  amount numeric(14, 2) not null check (amount > 0),
  created_at timestamptz not null default clock_timestamp(),
  unique (payment_id, line_no)
);
comment on table fuel.adblue_payment_allocations is 'How much of an AdBlue payment settles a bulk purchase of the same vendor.';
create index adblue_payment_allocations_purchase_idx on fuel.adblue_payment_allocations (purchase_id);

/* ------------------------------------------------------------------ the rules */

-- A payment may be edited (RLS: adblue:edit, Owner / Dev / Employee, open month) — never its vendor. Without a
-- signed-in ERP role (the SQL editor) only that rule applies.
create function private.adblue_payment_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.id <> old.id or new.vendor_id <> old.vendor_id or new.created_at <> old.created_at then
    raise exception 'An AdBlue payment''s vendor never changes — delete it and record it again.' using errcode = 'check_violation';
  end if;
  if private.erp_role() is not null and not (private.can('adblue', 'edit') and private.is_owner_or_dev()) and (to_jsonb(new) - 'updated_at') <> (to_jsonb(old) - 'updated_at') then
    raise exception 'Your role can''t edit AdBlue payments.' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
revoke all on function private.adblue_payment_guard() from public, anon, authenticated;
create trigger adblue_payments_guard before update on fuel.adblue_payments for each row execute function private.adblue_payment_guard();
create trigger adblue_payments_no_future before insert or update on fuel.adblue_payments for each row execute function private.refuse_future_date();
create trigger adblue_payments_touch before update on fuel.adblue_payments for each row execute function private.touch_updated_at();

-- Checked at COMMIT (rows locked first, so two writers can't both pass): a payment's allocations never exceed what it
-- settles; a purchase is paid only by its own vendor (never opening stock) and never beyond its value.
create function private.adblue_payment_check() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  pid text;
  rid text;
  allocated numeric;
  pay fuel.adblue_payments;
begin
  if tg_table_name = 'adblue_payment_allocations' then
    pid := new.payment_id;
    rid := new.purchase_id;
  elsif tg_table_name = 'adblue_payments' then
    pid := new.id;
  else
    rid := new.id; -- adblue_purchases
  end if;

  if pid is not null then
    select * into pay from fuel.adblue_payments p where p.id = pid for update;
    if found then
      select coalesce(sum(a.amount), 0) into allocated from fuel.adblue_payment_allocations a where a.payment_id = pid;
      if allocated > pay.amount + pay.tds_amount then
        raise exception 'AdBlue payment %: its allocations (%) are more than the payment settles (%).', pid, allocated, pay.amount + pay.tds_amount using errcode = 'check_violation';
      end if;
    end if;
  end if;

  if rid is not null and exists (select 1 from fuel.adblue_purchases r where r.id = rid) then
    perform 1 from fuel.adblue_purchases r where r.id = rid for update;
    if exists (
      select 1 from fuel.adblue_payment_allocations a join fuel.adblue_payments p on p.id = a.payment_id join fuel.adblue_purchases r on r.id = a.purchase_id
      where a.purchase_id = rid and (r.opening or r.vendor_id is distinct from p.vendor_id)
    ) then
      raise exception 'AdBlue purchase % is paid by a payment to another vendor (or is opening stock).', rid using errcode = 'check_violation';
    end if;
    if (select coalesce(sum(a.amount), 0) from fuel.adblue_payment_allocations a where a.purchase_id = rid)
       > (select r.total_cost + r.gst_amount from fuel.adblue_purchases r where r.id = rid) then
      raise exception 'AdBlue purchase % would be paid beyond its value.', rid using errcode = 'check_violation';
    end if;
  end if;
  return null;
end $$;
revoke all on function private.adblue_payment_check() from public, anon, authenticated;
create constraint trigger adblue_payments_allocated_check after insert or update on fuel.adblue_payments
  deferrable initially deferred for each row execute function private.adblue_payment_check();
create constraint trigger adblue_payment_allocations_allocated_check after insert on fuel.adblue_payment_allocations
  deferrable initially deferred for each row execute function private.adblue_payment_check();
-- A purchase edit (its value, or its vendor) keeps it within what was paid against it.
create constraint trigger adblue_purchases_paid_check after update on fuel.adblue_purchases
  deferrable initially deferred for each row execute function private.adblue_payment_check();

-- Allocation rows: removed by the Owner / Dev (deleting the payment, or an edit), or by the Employee only inside the
-- payment's audited edit whose "before" snapshot records an allocation to that purchase.
create function private.adblue_allocation_delete_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.erp_role() is null or private.can('adblue', 'delete') then
    return null;
  end if;
  if not exists (
    select 1 from audit.events e
    where e.txid = txid_current() and e.record_id = old.payment_id and e.action = 'UPDATED'
      and e.after is not null and e.before @> jsonb_build_object('allocations', jsonb_build_array(jsonb_build_object('purchaseId', old.purchase_id)))
  ) then
    raise exception 'Only the Owner and Dev can delete records: an AdBlue payment allocation (payment %) is removed only by an audited edit of its payment.', old.payment_id
      using errcode = 'insufficient_privilege';
  end if;
  return null;
end $$;
revoke all on function private.adblue_allocation_delete_guard() from public, anon, authenticated;
create constraint trigger adblue_payment_allocations_edit_delete after delete on fuel.adblue_payment_allocations
  deferrable initially deferred for each row execute function private.adblue_allocation_delete_guard();

/* ------------------------------------------------------------------ audit: no change without its event */

create constraint trigger adblue_payments_require_audit after insert or update or delete on fuel.adblue_payments
  deferrable initially deferred for each row execute function private.require_audit_event('id');
create constraint trigger adblue_payment_allocations_require_audit after insert or update or delete on fuel.adblue_payment_allocations
  deferrable initially deferred for each row execute function private.require_parent_audit_event('payment_id');

/* ------------------------------------------------------------------ grants and RLS (resource `adblue`, Owner / Dev / Employee) */

revoke all on fuel.adblue_payments, fuel.adblue_payment_allocations from public, anon, authenticated;
grant all on fuel.adblue_payments, fuel.adblue_payment_allocations to service_role;
grant select, insert, update, delete on fuel.adblue_payments to authenticated;
grant select, insert, delete on fuel.adblue_payment_allocations to authenticated; -- an edit rewrites them (no update)
alter table fuel.adblue_payments enable row level security;
alter table fuel.adblue_payment_allocations enable row level security;

create policy "Read AdBlue payments" on fuel.adblue_payments for select to authenticated
  using ((select private.can('adblue', 'view')) and (select private.is_owner_or_dev()));
create policy "Add AdBlue payments" on fuel.adblue_payments for insert to authenticated
  with check ((select private.can('adblue', 'create')) and (select private.is_owner_or_dev()) and private.month_open(date));
create policy "Edit AdBlue payments" on fuel.adblue_payments for update to authenticated
  using ((select private.can('adblue', 'edit')) and (select private.is_owner_or_dev()) and private.month_open(date))
  with check ((select private.can('adblue', 'edit')) and (select private.is_owner_or_dev()) and private.month_open(date));
-- Permanent deletion: the Owner / Dev only, the payment's month and every month of a purchase it paid open.
create policy "Delete AdBlue payments" on fuel.adblue_payments for delete to authenticated
  using ((select private.can('adblue', 'delete')) and private.month_open(date)
         and not exists (select 1 from fuel.adblue_payment_allocations a join fuel.adblue_purchases r on r.id = a.purchase_id
                         where a.payment_id = adblue_payments.id and not private.month_open(r.date)));

create policy "Read AdBlue payment allocations" on fuel.adblue_payment_allocations for select to authenticated
  using ((select private.can('adblue', 'view')) and (select private.is_owner_or_dev()));
create policy "Add AdBlue payment allocations" on fuel.adblue_payment_allocations for insert to authenticated
  with check (((select private.can('adblue', 'create')) or (select private.can('adblue', 'edit'))) and (select private.is_owner_or_dev())
              and exists (select 1 from fuel.adblue_payments p where p.id = payment_id and private.month_open(p.date))
              and exists (select 1 from fuel.adblue_purchases r where r.id = purchase_id and private.month_open(r.date)));
create policy "Remove AdBlue payment allocations" on fuel.adblue_payment_allocations for delete to authenticated
  using (((select private.can('adblue', 'delete')) or ((select private.can('adblue', 'edit')) and (select private.is_owner_or_dev())))
         and exists (select 1 from fuel.adblue_payments p where p.id = payment_id and private.month_open(p.date))
         and exists (select 1 from fuel.adblue_purchases r where r.id = purchase_id and private.month_open(r.date)));

commit;

/* ------------------------------------------------------------------ rollback (manual, reviewed; not part of the migration)
-- Deploy the app version without AdBlue payments first. Then, in one transaction (DESTROYS every AdBlue payment and
-- allocation, and every purchase's GST % — export them first; their audit events stay):
--   begin;
--   drop trigger adblue_purchases_paid_check on fuel.adblue_purchases;
--   drop table fuel.adblue_payment_allocations; drop table fuel.adblue_payments;
--   drop function private.adblue_payment_check(); drop function private.adblue_payment_guard(); drop function private.adblue_allocation_delete_guard();
--   alter table fuel.adblue_purchases drop column gst_amount, drop column gst_rate;
--   commit;
*/
