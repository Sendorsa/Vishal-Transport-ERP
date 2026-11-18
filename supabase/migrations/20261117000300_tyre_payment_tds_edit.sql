-- Tyre vendor payments: "Deduct TDS?", IMPS, corrections and permanent deletion (owner, 17 Nov 2026). Run ONCE in the Supabase Dashboard →
-- SQL Editor as one script, after 20261117000100_tyre_payments.sql. First
-- supabase/scripts/production-readonly/13-tyre-payment-tds-preflight.sql (read-only: every CHECK row OK), afterwards
-- 14-tyre-payment-tds-post-apply.sql (read-only: every CHECK row OK). It opens its own transaction: any error — or a
-- guard below — changes nothing.
--
-- TDS (the fuel stations' model — amount = what left the bank / cash; kept apart from that module):
--   amount      = paid to the vendor (cash / bank outflow)
--   tds_amount  = round((amount + tds_amount) × tds_rate / 100, 2)    total settled = amount + tds_amount
--   tds_rate    = the TDS % (NULL = no TDS: tds_amount 0 — every existing payment, unchanged)
-- Allocations, advance and invoice paid amounts are in settled terms: Σ allocations ≤ amount + tds_amount. There is no
-- monthly TDS mechanism for tyre vendors, so nothing can deduct the same purchases twice; none is introduced.
--
-- Corrections: a payment may now be edited (date, amounts, mode, TDS, reference, paid by, notes) by roles with
-- tyres:edit, in an open month (RLS: old and new date), with its audit event; its vendor never changes. An edit that
-- changes the allocations rewrites them: a role without delete removes allocation rows only inside the payment's
-- audited UPDATED event whose "before" snapshot records them (tyre_allocation_delete_guard — as tyre_item_delete_guard
-- does for invoice lines).
--
-- Deletion (owner, 17 Nov 2026 — replaces voiding): a payment is deleted permanently by the Owner / Dev only (RLS
-- private.can('tyres', 'delete'); the payment's month and every allocated invoice's month open), with its DELETED audit
-- event in the same transaction (require_audit_event: the event keeps the full payment, its allocations and TDS). Its
-- allocations go with it (on delete cascade — no orphan can remain), so the bills it paid are owed again. The columns
-- voided / void_reason are dropped: nothing is kept as "voided". The migration stops if any payment is voided.
--
-- Changes: on ops.tyre_payments two columns and two CHECK constraints added (the mode list gains IMPS), voided /
-- void_reason dropped (with their check and the partial UTR index, recreated over every payment), a DELETE grant and
-- policy; the functions tyre_payment_guard and tyre_payment_check replaced; on ops.tyre_payment_allocations the
-- payment foreign key becomes on delete cascade, one new function, trigger, policy and DELETE grant. No row changes.
-- Rollback (only while no payment has tds_rate set, uses IMPS, had allocations rewritten or was deleted — check the
-- audit trail first): restore both functions from 20261117000100_tyre_payments.sql; drop trigger
-- tyre_payment_allocations_edit_delete, function private.tyre_allocation_delete_guard(), policies "Remove tyre payment
-- allocations" and "Delete tyre payments"; revoke delete on both tables from authenticated; re-add the foreign key
-- without cascade; add back voided / void_reason, their check and the partial UTR index as in 20261117000100; drop
-- constraints tyre_payments_tds_check and tyre_payments_mode_check, columns tds_rate and tds_amount; add back
-- check (mode in ('Cash', 'UPI', 'NEFT', 'RTGS', 'Cheque')).

begin;

do $$
begin
  if to_regclass('ops.tyre_payments') is null or to_regprocedure('private.tyre_payment_check()') is null or to_regprocedure('private.tyre_payment_guard()') is null then
    raise exception 'Tyre payment TDS migration stopped: 20261117000100_tyre_payments.sql must be applied first. Nothing was changed.';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'ops' and table_name = 'tyre_payments' and column_name in ('tds_rate', 'tds_amount'))
     or to_regprocedure('private.tyre_allocation_delete_guard()') is not null then
    raise exception 'Tyre payment TDS migration stopped: it is already applied (fully or partly). Nothing was changed.';
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'ops.tyre_payments'::regclass and conname = 'tyre_payments_mode_check') then
    raise exception 'Tyre payment TDS migration stopped: the payment-mode constraint tyre_payments_mode_check is not as expected. Nothing was changed.';
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'ops.tyre_payment_allocations'::regclass and conname = 'tyre_payment_allocations_payment_id_fkey') then
    raise exception 'Tyre payment TDS migration stopped: the allocation foreign key tyre_payment_allocations_payment_id_fkey is not as expected. Nothing was changed.';
  end if;
  if exists (select 1 from ops.tyre_payments where voided) then
    raise exception 'Tyre payment TDS migration stopped: % voided payment(s) exist — voiding is replaced by deletion; review them first. Nothing was changed.', (select count(*) from ops.tyre_payments where voided);
  end if;
end $$;

/* ------------------------------------------------------------------ TDS and IMPS */

alter table ops.tyre_payments
  drop constraint tyre_payments_mode_check,
  add constraint tyre_payments_mode_check check (mode in ('Cash', 'UPI', 'NEFT', 'RTGS', 'IMPS', 'Cheque')), -- never Credit
  add column tds_rate numeric(8, 4) check (tds_rate >= 0 and tds_rate < 100),
  add column tds_amount numeric(14, 2) not null default 0 check (tds_amount >= 0),
  add constraint tyre_payments_tds_check check (
    (tds_rate is null and tds_amount = 0) or (tds_rate is not null and tds_amount = round((amount + tds_amount) * tds_rate / 100, 2))
  );
comment on column ops.tyre_payments.amount is 'Paid to the vendor (the bank / cash outflow). Total settled = amount + tds_amount.';
comment on column ops.tyre_payments.tds_rate is '"Deduct TDS?": the TDS % of the total settled. NULL = no TDS (tds_amount 0).';
-- Voiding is replaced by deletion: nothing is kept as "voided" (none exists — checked above). Dropping voided also drops
-- its check and the partial unique index; the reference is then unique over every payment.
alter table ops.tyre_payments drop column voided, drop column void_reason;
create unique index tyre_payments_utr_key on ops.tyre_payments (lower(regexp_replace(utr, '\s+', '', 'g')));
comment on table ops.tyre_payments is 'Payments to tyre suppliers. Edited (tyres:edit) or deleted permanently (Owner / Dev, with its audit event). Advance = amount + tds_amount − Σ allocations.';
comment on column ops.tyre_payments.utr is 'The payment''s reference: UTR (UPI / NEFT / RTGS / IMPS), cheque number (Cheque) or receipt number (Cash).';

/* ------------------------------------------------------------------ corrections */

-- A payment may be edited (RLS: tyres:edit, open month) — never its vendor. Without a signed-in ERP role (the SQL
-- editor) only that rule applies.
create or replace function private.tyre_payment_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.id <> old.id or new.supplier_kind <> old.supplier_kind or new.supplier_id <> old.supplier_id or new.created_at <> old.created_at then
    raise exception 'A tyre payment''s vendor never changes — delete it and record it again.' using errcode = 'check_violation';
  end if;
  if private.erp_role() is not null and not private.can('tyres', 'edit') and (to_jsonb(new) - 'updated_at') <> (to_jsonb(old) - 'updated_at') then
    raise exception 'Your role can''t edit tyre payments.' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

-- As before, with allocations measured against the total settled (amount + tds_amount).
create or replace function private.tyre_payment_check() returns trigger
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
    if allocated > pay.amount + pay.tds_amount then
      raise exception 'Tyre payment %: its allocations (%) are more than the payment settles (%).', pid, allocated, pay.amount + pay.tds_amount using errcode = 'check_violation';
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
    if (select coalesce(sum(a.amount), 0) from ops.tyre_payment_allocations a join ops.tyre_payments p on p.id = a.payment_id where a.invoice_id = iid)
       > (select coalesce(sum(t.total_value), 0) from ops.tyre_invoice_items t where t.invoice_id = iid) then
      raise exception 'Tyre invoice % would be paid beyond its total.', iid using errcode = 'check_violation';
    end if;
  end if;
  return null;
end $$;

-- Allocation rows: removed by the Owner / Dev, or by any other role only inside the payment's audited edit whose
-- "before" snapshot records an allocation to that invoice.
create function private.tyre_allocation_delete_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.erp_role() is null or private.can('tyres', 'delete') then
    return null;
  end if;
  if not exists (
    select 1 from audit.events e
    where e.txid = txid_current() and e.record_id = old.payment_id and e.action in ('UPDATED')
      and e.after is not null and e.before @> jsonb_build_object('allocations', jsonb_build_array(jsonb_build_object('invoiceId', old.invoice_id)))
  ) then
    raise exception 'Only the Owner and Dev can delete records: a tyre payment allocation (payment %) is removed only by an audited edit of its payment.', old.payment_id
      using errcode = 'insufficient_privilege';
  end if;
  return null;
end $$;
revoke all on function private.tyre_allocation_delete_guard() from public, anon, authenticated;
create constraint trigger tyre_payment_allocations_edit_delete after delete on ops.tyre_payment_allocations
  deferrable initially deferred for each row execute function private.tyre_allocation_delete_guard();

/* ------------------------------------------------------------------ deletion (Owner / Dev) */

-- A payment's allocations go with it: none can be left pointing at a deleted payment.
alter table ops.tyre_payment_allocations
  drop constraint tyre_payment_allocations_payment_id_fkey,
  add constraint tyre_payment_allocations_payment_id_fkey foreign key (payment_id) references ops.tyre_payments (id) on delete cascade;

-- The Owner / Dev only (private.can refuses delete to every other role), the payment's month and every month of a bill
-- it paid open; require_audit_event (20261117000100) demands its DELETED event in the same transaction.
grant delete on ops.tyre_payments to authenticated;
create policy "Delete tyre payments" on ops.tyre_payments for delete to authenticated
  using ((select private.can('tyres', 'delete')) and private.month_open(date)
         and not exists (select 1 from ops.tyre_payment_allocations a join ops.tyre_invoices i on i.id = a.invoice_id
                         where a.payment_id = tyre_payments.id and not private.month_open(i.date)));

grant delete on ops.tyre_payment_allocations to authenticated;
create policy "Remove tyre payment allocations" on ops.tyre_payment_allocations for delete to authenticated
  using (((select private.can('tyres', 'delete')) or (select private.can('tyres', 'edit')))
         and exists (select 1 from ops.tyre_payments p where p.id = payment_id and private.month_open(p.date))
         and exists (select 1 from ops.tyre_invoices i where i.id = invoice_id and private.month_open(i.date)));

commit;
