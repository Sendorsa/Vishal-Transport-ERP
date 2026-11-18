-- AdBlue → direct vendor purchases on vendor credit (owner, 18 Nov 2026). Run ONCE in the Supabase Dashboard → SQL
-- Editor as one script, after 20261118000000_adblue_supplier_payments.sql. First
-- supabase/scripts/production-readonly/17-adblue-direct-payments-preflight.sql (read-only: every CHECK row OK), afterwards
-- 18-adblue-direct-payments-post-apply.sql (read-only: every CHECK row OK). It opens its own transaction: any error — or a
-- guard below — changes nothing.
--
-- Why a migration: a payment allocation could only point at a bulk purchase (purchase_id → fuel.adblue_purchases), and a
-- direct purchase (fuel.adblue_entries, source DIRECT) could only be "paid at purchase" (payment_mode CASH / UPI / NEFT /
-- CHEQUE). Direct purchases now join the one AdBlue vendor payment system:
--   • payment_mode gains 'CREDIT' = on the vendor's account: owed until AdBlue payments (fuel.adblue_payments) settle it.
--     Every existing direct purchase keeps its mode = paid at purchase: never outstanding, no payment invented.
--   • an allocation points at exactly one of: a bulk purchase (purchase_id) or a direct purchase on credit (entry_id).
--   • value of a direct purchase = its amount (litres × rate, generated); paid = Σ allocations; never paid beyond its
--     value, only by a payment to its own vendor (vendor_id), and only while it is a DIRECT entry on CREDIT — also after
--     an edit of the entry (checked at COMMIT); an entry with allocations can't be deleted (foreign key).
-- Stock is untouched: direct purchases never were stock, and nothing here changes a bulk purchase, a draw or FIFO.
-- Changes: one enum value; one column, one CHECK and one index on fuel.adblue_payment_allocations (purchase_id becomes
-- nullable); the functions adblue_payment_check and adblue_allocation_delete_guard replaced; one constraint trigger on
-- fuel.adblue_entries; the allocation insert / delete policies and the payment delete policy replaced (the same rules,
-- now also for direct purchases). No existing row changes.
-- Rollback (only while no entry is on CREDIT and no allocation has entry_id — check first): restore both functions and
-- the three policies from 20261118000000_adblue_supplier_payments.sql; drop trigger adblue_entries_paid_check; drop
-- constraint adblue_payment_allocations_target_check, column entry_id; set purchase_id not null. (An enum value can't
-- be dropped; 'CREDIT' unused is harmless.)

begin;

do $$
begin
  if to_regclass('fuel.adblue_payments') is null or to_regclass('fuel.adblue_payment_allocations') is null or to_regprocedure('private.adblue_payment_check()') is null then
    raise exception 'AdBlue direct payments migration stopped: 20261118000000_adblue_supplier_payments.sql must be applied first. Nothing was changed.';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'fuel' and table_name = 'adblue_payment_allocations' and column_name = 'entry_id')
     or exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'fuel' and t.typname = 'adblue_payment_mode' and e.enumlabel = 'CREDIT') then
    raise exception 'AdBlue direct payments migration stopped: it is already applied (fully or partly). Nothing was changed.';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'fuel' and table_name = 'adblue_entries' and column_name = 'vendor_id') then
    raise exception 'AdBlue direct payments migration stopped: fuel.adblue_entries.vendor_id is missing (20261116000000). Nothing was changed.';
  end if;
end $$;

/* ------------------------------------------------------------------ direct purchases on the vendor's account */

-- Used only in function bodies below (run later), never in this transaction's DDL — safe inside the transaction.
alter type fuel.adblue_payment_mode add value 'CREDIT';
comment on column fuel.adblue_entries.payment_mode is 'DIRECT only: how it was paid. CREDIT = on the vendor''s account, settled by AdBlue payments (fuel.adblue_payments); CASH / UPI / NEFT / CHEQUE = paid at purchase.';

alter table fuel.adblue_payment_allocations
  alter column purchase_id drop not null,
  add column entry_id text references fuel.adblue_entries (id), -- a direct purchase with payments can't be deleted
  add constraint adblue_payment_allocations_target_check check (num_nonnulls(purchase_id, entry_id) = 1);
create index adblue_payment_allocations_entry_idx on fuel.adblue_payment_allocations (entry_id);
comment on table fuel.adblue_payment_allocations is 'How much of an AdBlue payment settles a bulk purchase (purchase_id) or a direct purchase on credit (entry_id) of the same vendor.';

/* ------------------------------------------------------------------ the rules */

-- Checked at COMMIT (rows locked first): a payment's allocations never exceed what it settles; a bulk purchase or a
-- direct purchase on credit is paid only by its own vendor and never beyond its value (also after its edit).
create or replace function private.adblue_payment_check() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  pid text;
  rid text;
  eid text;
  allocated numeric;
  pay fuel.adblue_payments;
begin
  if tg_table_name = 'adblue_payment_allocations' then
    pid := new.payment_id;
    rid := new.purchase_id;
    eid := new.entry_id;
  elsif tg_table_name = 'adblue_payments' then
    pid := new.id;
  elsif tg_table_name = 'adblue_entries' then
    eid := new.id;
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

  if eid is not null and exists (select 1 from fuel.adblue_entries e where e.id = eid) then
    perform 1 from fuel.adblue_entries e where e.id = eid for update;
    if exists (select 1 from fuel.adblue_payment_allocations a where a.entry_id = eid) then
      if exists (
        select 1 from fuel.adblue_payment_allocations a join fuel.adblue_payments p on p.id = a.payment_id join fuel.adblue_entries e on e.id = a.entry_id
        where a.entry_id = eid and (e.source <> 'DIRECT' or e.payment_mode is distinct from 'CREDIT' or e.vendor_id is distinct from p.vendor_id)
      ) then
        raise exception 'AdBlue direct purchase % is paid by a payment to another vendor (or is not a direct purchase on credit).', eid using errcode = 'check_violation';
      end if;
      if (select coalesce(sum(a.amount), 0) from fuel.adblue_payment_allocations a where a.entry_id = eid)
         > (select e.amount from fuel.adblue_entries e where e.id = eid) then
        raise exception 'AdBlue direct purchase % would be paid beyond its value.', eid using errcode = 'check_violation';
      end if;
    end if;
  end if;
  return null;
end $$;
revoke all on function private.adblue_payment_check() from public, anon, authenticated;
-- A direct purchase's edit (litres, rate, vendor, mode, source) keeps it within what was paid against it.
create constraint trigger adblue_entries_paid_check after update on fuel.adblue_entries
  deferrable initially deferred for each row execute function private.adblue_payment_check();

-- Allocation rows: removed by the Owner / Dev, or by the Employee only inside the payment's audited edit whose "before"
-- snapshot records an allocation to that purchase (the app records a direct purchase's id under the same key).
create or replace function private.adblue_allocation_delete_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.erp_role() is null or private.can('adblue', 'delete') then
    return null;
  end if;
  if not exists (
    select 1 from audit.events e
    where e.txid = txid_current() and e.record_id = old.payment_id and e.action = 'UPDATED'
      and e.after is not null and e.before @> jsonb_build_object('allocations', jsonb_build_array(jsonb_build_object('purchaseId', coalesce(old.purchase_id, old.entry_id))))
  ) then
    raise exception 'Only the Owner and Dev can delete records: an AdBlue payment allocation (payment %) is removed only by an audited edit of its payment.', old.payment_id
      using errcode = 'insufficient_privilege';
  end if;
  return null;
end $$;
revoke all on function private.adblue_allocation_delete_guard() from public, anon, authenticated;

/* ------------------------------------------------------------------ RLS: the same rules, for direct purchases too */

drop policy "Delete AdBlue payments" on fuel.adblue_payments;
create policy "Delete AdBlue payments" on fuel.adblue_payments for delete to authenticated
  using ((select private.can('adblue', 'delete')) and private.month_open(date)
         and not exists (select 1 from fuel.adblue_payment_allocations a
                         left join fuel.adblue_purchases r on r.id = a.purchase_id left join fuel.adblue_entries e on e.id = a.entry_id
                         where a.payment_id = adblue_payments.id and not private.month_open(coalesce(r.date, e.date))));

drop policy "Add AdBlue payment allocations" on fuel.adblue_payment_allocations;
create policy "Add AdBlue payment allocations" on fuel.adblue_payment_allocations for insert to authenticated
  with check (((select private.can('adblue', 'create')) or (select private.can('adblue', 'edit'))) and (select private.is_owner_or_dev())
              and exists (select 1 from fuel.adblue_payments p where p.id = payment_id and private.month_open(p.date))
              and (purchase_id is null or exists (select 1 from fuel.adblue_purchases r where r.id = purchase_id and private.month_open(r.date)))
              and (entry_id is null or exists (select 1 from fuel.adblue_entries e where e.id = entry_id and private.month_open(e.date))));

drop policy "Remove AdBlue payment allocations" on fuel.adblue_payment_allocations;
create policy "Remove AdBlue payment allocations" on fuel.adblue_payment_allocations for delete to authenticated
  using (((select private.can('adblue', 'delete')) or ((select private.can('adblue', 'edit')) and (select private.is_owner_or_dev())))
         and exists (select 1 from fuel.adblue_payments p where p.id = payment_id and private.month_open(p.date))
         and (purchase_id is null or exists (select 1 from fuel.adblue_purchases r where r.id = purchase_id and private.month_open(r.date)))
         and (entry_id is null or exists (select 1 from fuel.adblue_entries e where e.id = entry_id and private.month_open(e.date))));

commit;
