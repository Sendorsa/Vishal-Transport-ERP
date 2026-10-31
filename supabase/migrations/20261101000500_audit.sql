-- Diesel database, phase 1 — design approved by the owner on 1 Nov 2026 (D-1 … D-18). See docs/SUPABASE_DIESEL_DATABASE_SCHEMA.md §7.
--
-- The audit trail (CLAUDE.md "Audit Trail and Edit History Rules"). The app writes each event — its label, module,
-- before / after snapshots and reason — in the same transaction as the change. The database guarantees:
--   1. append-only: no UPDATE / DELETE / TRUNCATE, for any role;
--   2. no change without its event: a deferred check at COMMIT refuses any audited row change whose transaction
--      wrote no event for that record (a delete needs a DELETED event, which needs a reason of ≥ 3 characters);
--   3. a deletion is restored at most once, and only from a DELETED event of the same record.

create type audit.action as enum (
  'CREATED', 'UPDATED', 'DELETED', 'ARCHIVED', 'RESTORED', 'TRANSFERRED', 'PAYMENT_RECORDED', 'MONTH_LOCKED', 'MONTH_UNLOCKED', 'DATA_RESET'
);
create type audit.actor_kind as enum ('SESSION', 'SYSTEM');

create table audit.events (
  id text primary key default private.new_id('aud'),
  at timestamptz not null default clock_timestamp(), -- stored UTC, shown in IST
  txid bigint not null default txid_current(), -- the writing transaction (for the "no change without its event" check)
  actor_kind audit.actor_kind not null,
  actor_user_id uuid references public.profiles (id),
  actor_name text,
  actor_role public.erp_role, -- the role at the time of the event
  action audit.action not null,
  module text not null check (btrim(module) <> ''),
  record_type text not null check (btrim(record_type) <> ''),
  record_id text not null check (btrim(record_id) <> ''), -- no foreign key: the record may since be deleted
  label text not null default '',
  record_date date,
  before jsonb,
  after jsonb,
  changes jsonb not null default '[]' check (jsonb_typeof(changes) = 'array'),
  reason text,
  restores_event_id text unique references audit.events (id), -- a deletion is restored once
  note text,
  check (actor_kind = 'SYSTEM' or (actor_user_id is not null and actor_role is not null)),
  check (action <> 'DELETED' or length(btrim(reason)) >= 3),
  check (restores_event_id is null or (action = 'RESTORED' and length(btrim(reason)) >= 3))
);
create index audit_events_record_idx on audit.events (record_id, at);
create index audit_events_module_idx on audit.events (module, at);
create index audit_events_action_idx on audit.events (action, at);
create index audit_events_at_idx on audit.events (at);
create index audit_events_txid_idx on audit.events (txid, record_id);

-- The Owner has reviewed one deletion (the Audit Log badge). Append-only; never changes the event.
create table audit.reviews (
  event_id text primary key references audit.events (id),
  at timestamptz not null default clock_timestamp(),
  actor_user_id uuid references public.profiles (id),
  actor_role public.erp_role not null
);

create function private.audit_append_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'The audit trail is append-only: % on %.% is not allowed.', tg_op, tg_table_schema, tg_table_name using errcode = 'insufficient_privilege';
end $$;

create trigger events_append_only before update or delete on audit.events for each row execute function private.audit_append_only();
create trigger events_no_truncate before truncate on audit.events for each statement execute function private.audit_append_only();
create trigger reviews_append_only before update or delete on audit.reviews for each row execute function private.audit_append_only();
create trigger reviews_no_truncate before truncate on audit.reviews for each statement execute function private.audit_append_only();

-- A RESTORED event must reverse a DELETED event of the same record; a review must be of a DELETED event.
create function private.audit_event_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.restores_event_id is not null and not exists (
    select 1 from audit.events e where e.id = new.restores_event_id and e.action = 'DELETED' and e.record_id = new.record_id
  ) then
    raise exception 'A restore must point to a deletion event of the same record.' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger events_guard before insert on audit.events for each row execute function private.audit_event_guard();

create function private.audit_review_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from audit.events e where e.id = new.event_id and e.action = 'DELETED') then
    raise exception 'Only deletion events can be reviewed.' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger reviews_guard before insert on audit.reviews for each row execute function private.audit_review_guard();

-- No change without its event. Arguments: the column holding the audit record id (default id; '=settings' = a
-- fixed record id, as the app audits Settings), then columns whose change alone needs no event (caches).
create function private.require_audit_event() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  o jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  n jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  id_arg text := coalesce(tg_argv[0], 'id');
  ignored text[] := array['updated_at'] || coalesce(tg_argv[1:], '{}'::text[]);
  rid text;
begin
  if tg_op = 'UPDATE' and (o - ignored) = (n - ignored) then
    return null;
  end if;
  rid := case when id_arg like '=%' then substr(id_arg, 2) else coalesce(n, o) ->> id_arg end;
  if not exists (
    select 1 from audit.events e
    where e.txid = txid_current() and e.record_id = rid and (tg_op <> 'DELETE' or e.action = 'DELETED')
  ) then
    raise exception '% of %.% (record %) has no audit event in the same transaction.', tg_op, tg_table_schema, tg_table_name, rid
      using errcode = 'integrity_constraint_violation';
  end if;
  return null;
end $$;

do $$
declare
  r record;
begin
  for r in select * from (values
    ('core', 'companies', '''=settings'''),
    ('core', 'vehicle_types', '''=settings'''),
    ('core', 'customers', '''id'''),
    ('core', 'customer_status_periods', '''customer_id'''),
    ('core', 'drivers', '''id'''),
    ('core', 'vehicles', '''id'', ''odometer_km'''),
    ('core', 'vehicle_status_periods', '''vehicle_id'''),
    ('core', 'vehicle_assignments', '''vehicle_id'''),
    ('core', 'month_locks', '''month'''),
    ('fuel', 'fuel_stations', '''id'''),
    ('fuel', 'tankers', '''id'''),
    ('fuel', 'diesel_entries', '''id'''),
    ('fuel', 'tanker_loads', '''id'''),
    ('fuel', 'tanker_transfers', '''id'''),
    ('fuel', 'tanker_adjustments', '''id'''),
    ('fuel', 'adblue_purchases', '''id'''),
    ('fuel', 'adblue_entries', '''id'''),
    ('finance', 'payments', '''id''')
  ) as t (sch, tbl, args) loop
    execute format(
      'create constraint trigger %2$s_require_audit after insert or update or delete on %1$s.%2$s deferrable initially deferred for each row execute function private.require_audit_event(%3$s)',
      r.sch, r.tbl, r.args);
  end loop;
end $$;
