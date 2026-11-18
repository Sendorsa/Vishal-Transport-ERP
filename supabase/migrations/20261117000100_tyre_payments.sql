-- Tyre Data → vendor payments (owner, 17 Nov 2026): payments to tyre suppliers and their allocations to tyre invoices.
-- Run ONCE in the Supabase Dashboard → SQL Editor as one script, after 20261117000000_tyre_data.sql. First run
-- supabase/scripts/production-readonly/11-tyre-payments-preflight.sql (read-only: every row OK), afterwards
-- 12-tyre-payments-post-apply.sql (read-only: every row OK). It opens its own transaction: any error — or a guard
-- below — changes nothing.
--
-- Why not finance.payments: its allocations (finance.payment_allocations) reference customer sales invoices
-- (billing.invoices) and accept only an ISSUED one, and its supplier link is a fuel station. Tyre suppliers are
-- ops.tyre_masters (SUPPLIER) and tyre bills are ops.tyre_invoices, so these two tables hold what a tyre payment is —
-- no second copy of any payment, invoice or supplier, and the Payments module, Reports and fuel station ledgers are
-- unchanged.
--
-- The accounting (src/domain/tyre.ts, the same figures everywhere):
--   invoice paid        = Σ its allocations from payments not voided;  outstanding = invoice total − paid
--   payment advance     = amount − Σ its allocations (credit with the supplier, not yet on a bill)
--   vendor balance      = Σ invoice totals − Σ payments (not voided) = Σ outstanding − Σ advance
-- Rules enforced here (the API checks them first, with clearer messages):
--   • a payment is money paid: amount > 0, a mode (Cash / UPI / NEFT / RTGS / Cheque — never Credit), a UTR, not dated
--     in the future; one UTR is never on two live payments (spaces / case ignored);
--   • allocations go to invoices of the payment's own supplier; Σ allocations ≤ the payment; an invoice is never paid
--     beyond its total — also after an edit of its lines (checked at COMMIT, the invoice row locked first);
--   • a payment is never edited and never deleted: it is voided (the Owner / Dev — the delete rule — with a reason),
--     once; allocations are only ever added (no update or delete grant) and never to a voided payment;
--   • an invoice that payments point at can't be deleted (foreign key): payment history is never rewritten;
--   • every change has its audit event in the same transaction; the Monthly Sheet Lock applies to the payment's date
--     and to each allocated invoice's date.
-- Additive: two new tables, their functions, triggers and policies, and two constraint triggers on the tyre invoice
-- tables (paid ≤ total, same supplier). No existing row, column or policy changes; no permission row (the `tyres`
-- resource covers it: view / create / edit for the Owner and Employee, void = delete = the Owner and Dev).
-- No payment is created for any existing invoice: they stay unpaid / outstanding until a real payment is recorded.
-- Rollback: see the end of this file.

begin;

do $$
begin
  if to_regclass('ops.tyre_payments') is not null or to_regclass('ops.tyre_payment_allocations') is not null
     or to_regproc('private.tyre_payment_check') is not null or to_regproc('private.tyre_payment_guard') is not null then
    raise exception 'Tyre payments migration stopped: it is already applied (fully or partly). Nothing was changed.';
  end if;
  if to_regclass('ops.tyre_invoices') is null or to_regclass('ops.tyre_invoice_items') is null or to_regclass('ops.tyre_masters') is null
     or to_regproc('private.tyre_item_delete_guard') is null then
    raise exception 'Tyre payments migration stopped: 20261117000000_tyre_data.sql must be applied first. Nothing was changed.';
  end if;
end $$;

/* ------------------------------------------------------------------ payments and allocations */

create table ops.tyre_payments (
  id text primary key default private.new_id('tpy'),
  date date not null, -- the day the money was paid
  supplier_kind text not null default 'SUPPLIER' check (supplier_kind = 'SUPPLIER'),
  supplier_id text not null,
  amount numeric(14, 2) not null check (amount > 0),
  mode text not null check (mode in ('Cash', 'UPI', 'NEFT', 'RTGS', 'Cheque')), -- never Credit: Credit is no payment
  utr text not null check (btrim(utr) <> '' and length(utr) <= 120),
  reference text not null default '',
  company_code text references core.companies (code), -- paid by (VT / VTHPL), when recorded
  notes text not null default '',
  voided boolean not null default false,
  void_reason text not null default '',
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  foreign key (supplier_kind, supplier_id) references ops.tyre_masters (kind, id),
  check (not voided or length(btrim(void_reason)) >= 3)
);
comment on table ops.tyre_payments is 'Payments to tyre suppliers. Never edited or deleted: voided (Owner / Dev, with a reason). Advance = amount − Σ allocations.';
create index tyre_payments_supplier_idx on ops.tyre_payments (supplier_id, date);
-- One bank transaction (UTR) on one live payment — spaces and case ignored (the app's utrKey).
create unique index tyre_payments_utr_key on ops.tyre_payments (lower(regexp_replace(utr, '\s+', '', 'g'))) where not voided;

create table ops.tyre_payment_allocations (
  id text primary key default private.new_id('tpa'),
  payment_id text not null references ops.tyre_payments (id),
  line_no int not null check (line_no >= 0), -- the order allocations were made in (applied advance comes after)
  invoice_id text not null references ops.tyre_invoices (id), -- an invoice with payment history can't be deleted
  amount numeric(14, 2) not null check (amount > 0),
  created_at timestamptz not null default clock_timestamp(),
  unique (payment_id, line_no)
);
comment on table ops.tyre_payment_allocations is 'How much of a tyre payment settles a tyre invoice of the same supplier. Insert only.';
create index tyre_payment_allocations_invoice_idx on ops.tyre_payment_allocations (invoice_id);

/* ------------------------------------------------------------------ the rules */

-- A payment changes only by being voided (once, by the Owner / Dev — the delete rule); updated_at may be touched when
-- allocations are added. Without a signed-in ERP role (the SQL editor) only the immutability applies.
create function private.tyre_payment_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.voided then
    raise exception 'A voided tyre payment can''t be changed.' using errcode = 'check_violation';
  end if;
  if (to_jsonb(new) - array['voided', 'void_reason', 'updated_at']) <> (to_jsonb(old) - array['voided', 'void_reason', 'updated_at']) then
    raise exception 'A tyre payment is never edited — void it (with a reason) and record it again.' using errcode = 'check_violation';
  end if;
  if new.voided and private.erp_role() is not null and not private.can('tyres', 'delete') then
    raise exception 'Only the Owner and Dev can void a tyre payment.' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
revoke all on function private.tyre_payment_guard() from public, anon, authenticated;
create trigger tyre_payments_guard before update on ops.tyre_payments for each row execute function private.tyre_payment_guard();
create trigger tyre_payments_no_future before insert or update on ops.tyre_payments for each row execute function private.refuse_future_date();
create trigger tyre_payments_touch before update on ops.tyre_payments for each row execute function private.touch_updated_at();

-- Checked at COMMIT (rows locked first, so two writers can't both pass): a payment's allocations never exceed it and
-- never go to a voided payment; an invoice is paid only by its own supplier and never beyond its total.
create function private.tyre_payment_check() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  pid text;
  iid text;
  allocated numeric;
  pay ops.tyre_payments;
begin
  if tg_table_name = 'tyre_payment_allocations' then
    pid := new.payment_id;
    iid := new.invoice_id;
  elsif tg_table_name = 'tyre_payments' then
    pid := new.id;
  elsif tg_table_name = 'tyre_invoices' then
    iid := new.id;
  elsif tg_op = 'DELETE' then
    iid := old.invoice_id;
  else
    iid := new.invoice_id;
  end if;

  if pid is not null then
    select * into pay from ops.tyre_payments p where p.id = pid for update;
    select coalesce(sum(a.amount), 0) into allocated from ops.tyre_payment_allocations a where a.payment_id = pid;
    if allocated > pay.amount then
      raise exception 'Tyre payment %: its allocations (%) are more than the payment (%).', pid, allocated, pay.amount using errcode = 'check_violation';
    end if;
    if tg_table_name = 'tyre_payment_allocations' and pay.voided then
      raise exception 'Tyre payment % is voided: nothing more can be allocated from it.', pid using errcode = 'check_violation';
    end if;
  end if;

  if iid is not null and exists (select 1 from ops.tyre_invoices i where i.id = iid) then
    perform 1 from ops.tyre_invoices i where i.id = iid for update;
    if exists (
      select 1 from ops.tyre_payment_allocations a join ops.tyre_payments p on p.id = a.payment_id join ops.tyre_invoices i on i.id = a.invoice_id
      where a.invoice_id = iid and p.supplier_id <> i.supplier_id
    ) then
      raise exception 'Tyre invoice % is paid by a payment to another supplier.', iid using errcode = 'check_violation';
    end if;
    if (select coalesce(sum(a.amount), 0) from ops.tyre_payment_allocations a join ops.tyre_payments p on p.id = a.payment_id where a.invoice_id = iid and not p.voided)
       > (select coalesce(sum(t.total_value), 0) from ops.tyre_invoice_items t where t.invoice_id = iid) then
      raise exception 'Tyre invoice % would be paid beyond its total.', iid using errcode = 'check_violation';
    end if;
  end if;
  return null;
end $$;
revoke all on function private.tyre_payment_check() from public, anon, authenticated;
create constraint trigger tyre_payments_allocated_check after insert or update on ops.tyre_payments
  deferrable initially deferred for each row execute function private.tyre_payment_check();
create constraint trigger tyre_payment_allocations_allocated_check after insert on ops.tyre_payment_allocations
  deferrable initially deferred for each row execute function private.tyre_payment_check();
-- An invoice edit (its lines, or its supplier) keeps it within what was paid against it.
create constraint trigger tyre_invoices_paid_check after update on ops.tyre_invoices
  deferrable initially deferred for each row execute function private.tyre_payment_check();
create constraint trigger tyre_invoice_items_paid_check after insert or update or delete on ops.tyre_invoice_items
  deferrable initially deferred for each row execute function private.tyre_payment_check();

/* ------------------------------------------------------------------ audit: no change without its event */

create constraint trigger tyre_payments_require_audit after insert or update or delete on ops.tyre_payments
  deferrable initially deferred for each row execute function private.require_audit_event('id');
-- An allocation is added only with its payment's event (PAYMENT_RECORDED, or UPDATED when advance is applied).
create constraint trigger tyre_payment_allocations_require_audit after insert or update or delete on ops.tyre_payment_allocations
  deferrable initially deferred for each row execute function private.require_parent_audit_event('payment_id');

/* ------------------------------------------------------------------ grants and RLS (resource `tyres`) */

revoke all on ops.tyre_payments, ops.tyre_payment_allocations from public, anon, authenticated;
grant all on ops.tyre_payments, ops.tyre_payment_allocations to service_role;
grant select, insert, update on ops.tyre_payments to authenticated; -- no delete: void
grant select, insert on ops.tyre_payment_allocations to authenticated; -- insert only
alter table ops.tyre_payments enable row level security;
alter table ops.tyre_payment_allocations enable row level security;

create policy "Read tyre payments" on ops.tyre_payments for select to authenticated using ((select private.can('tyres', 'view')));
create policy "Add tyre payments" on ops.tyre_payments for insert to authenticated
  with check ((select private.can('tyres', 'create')) and private.month_open(date));
-- Applying advance (edit) touches the row; voiding needs delete (tyre_payment_guard).
create policy "Change tyre payments" on ops.tyre_payments for update to authenticated
  using (((select private.can('tyres', 'edit')) or (select private.can('tyres', 'delete'))) and private.month_open(date))
  with check (((select private.can('tyres', 'edit')) or (select private.can('tyres', 'delete'))) and private.month_open(date));

create policy "Read tyre payment allocations" on ops.tyre_payment_allocations for select to authenticated using ((select private.can('tyres', 'view')));
create policy "Add tyre payment allocations" on ops.tyre_payment_allocations for insert to authenticated
  with check (((select private.can('tyres', 'create')) or (select private.can('tyres', 'edit')))
              and exists (select 1 from ops.tyre_payments p where p.id = payment_id and private.month_open(p.date))
              and exists (select 1 from ops.tyre_invoices i where i.id = invoice_id and private.month_open(i.date)));

commit;

/* ------------------------------------------------------------------ rollback (manual, reviewed; not part of the migration)
-- Deploy the app version without tyre payments first. Then, in one transaction (DESTROYS every tyre payment and
-- allocation — export them first; their audit events stay):
--   begin;
--   drop trigger tyre_invoices_paid_check on ops.tyre_invoices; drop trigger tyre_invoice_items_paid_check on ops.tyre_invoice_items;
--   drop table ops.tyre_payment_allocations; drop table ops.tyre_payments;
--   drop function private.tyre_payment_check(); drop function private.tyre_payment_guard();
--   commit;
*/
