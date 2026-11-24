-- Diesel Tankers → correcting a transfer or a stock adjustment (owner, 18 Nov 2026: every role that may record it may
-- correct it; only the Owner and Dev delete). Run ONCE in the Supabase Dashboard → SQL Editor as one script, after
-- 20261118000100_adblue_direct_purchase_payments.sql. It opens its own transaction: any error — or a guard below —
-- changes nothing.
--
-- Why a migration: fuel.tanker_transfers and fuel.tanker_adjustments were "no edits: delete and re-enter"
-- (20261101000600: insert + delete grants only, no UPDATE policy). Since 16 Nov 2026 only the Owner / Dev delete, so an
-- Employee could record a transfer or adjustment but never correct one. The app now edits them
-- (api.tankerTransfers.update / api.tankerAdjustments.update, diesel:edit); the database must accept that UPDATE.
--
-- Changes: UPDATE granted on the two tables; one UPDATE policy each — diesel:edit (OWNER, DEV, EMPLOYEE; the AdBlue
-- profiles hold diesel:view only) and the month open for the role on the old date (USING) and the new date (WITH CHECK).
-- Nothing else is needed — these already fire on UPDATE (20261101000300 / 20261101000500): the per-tanker stock lock and
-- the deferred stock check (old and new tankers: never below zero), refuse_future_date, touch_updated_at (the app's
-- optimistic version), the CHECKs (litres > 0 / ≠ 0, reason ≥ 3 characters) and require_audit_event (an UPDATED event
-- in the same transaction). DELETE is unchanged: private.can('diesel', 'delete') = Owner / Dev only. No row changes.
--
-- Verify afterwards (read-only):
--   select tablename, policyname, cmd from pg_policies where schemaname = 'fuel' and tablename in ('tanker_transfers', 'tanker_adjustments') order by 1, 3;
--     → each table: SELECT, INSERT, UPDATE ("Edit …"), DELETE
--   select table_name, privilege_type from information_schema.role_table_grants where grantee = 'authenticated' and table_schema = 'fuel' and table_name in ('tanker_transfers', 'tanker_adjustments') order by 1, 2;
--     → each table: DELETE, INSERT, SELECT, UPDATE
-- Rollback: drop policy "Edit tanker transfers" on fuel.tanker_transfers; drop policy "Edit tanker adjustments" on
-- fuel.tanker_adjustments; revoke update on fuel.tanker_transfers, fuel.tanker_adjustments from authenticated.
-- (Deploy the previous app first: it never edits them.)

begin;

do $$
begin
  if to_regclass('fuel.tanker_transfers') is null or to_regclass('fuel.tanker_adjustments') is null or to_regprocedure('private.can(text, text)') is null then
    raise exception 'Tanker edit migration stopped: the Diesel schema (20261101000300 … 20261116000000) must be applied first. Nothing was changed.';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'fuel' and tablename in ('tanker_transfers', 'tanker_adjustments') and cmd = 'UPDATE') then
    raise exception 'Tanker edit migration stopped: it is already applied (fully or partly). Nothing was changed.';
  end if;
end $$;

grant update on fuel.tanker_transfers, fuel.tanker_adjustments to authenticated;

create policy "Edit tanker transfers" on fuel.tanker_transfers for update to authenticated
  using ((select private.can('diesel', 'edit')) and private.month_open(date)) with check ((select private.can('diesel', 'edit')) and private.month_open(date));
create policy "Edit tanker adjustments" on fuel.tanker_adjustments for update to authenticated
  using ((select private.can('diesel', 'edit')) and private.month_open(date)) with check ((select private.can('diesel', 'edit')) and private.month_open(date));

comment on table fuel.tanker_transfers is 'Diesel moved from one company tanker to another. Never a purchase. Corrected by diesel:edit; deleted by the Owner / Dev only.';
comment on table fuel.tanker_adjustments is 'A correction of one tanker''s stock (dip reading, leak, spillage): + adds, − removes; reason mandatory. Corrected by diesel:edit; deleted by the Owner / Dev only.';

commit;
