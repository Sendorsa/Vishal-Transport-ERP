-- Expense on the shared database (Phase 2B — docs/PHASE_2B_IMPLEMENTATION_PLAN.md, revision 5). Run ONCE in the
-- Supabase Dashboard → SQL Editor as one script, AFTER 20261127000000_driver_master_company_periods.sql. It opens its own
-- transaction: any error — or a guard below — changes nothing. NOT YET APPLIED to any project (owner's go-ahead needed).
-- Run supabase/scripts/production-readonly/27-expense-preflight.sql first (every CHECK row OK), then this, then
-- 28-expense-post-apply.sql.
--
-- What it adds (new schema `expense`, six tables — the Phase 1 browser collections, one table each):
--   1. expense.import_batches   one row per applied import of a browser backup (fingerprint unique, report, snapshot)
--   2. expense.import_items     one row per source record of a batch (outcome, reason)
--   3. expense.brokers          the broker list (unique name ignoring case / spaces); no rename or delete (Phase 1)
--   4. expense.entries          every Expense entry, all five sections; section CHECKs = the Phase 1 save rules
--   5. expense.entry_vehicles   an entry's vehicles in order (exactly one for Road Tax / Insurance / Fitness / Fines)
--   6. expense.month_locks      locked section-months; append-only — NO unlock exists (no update / delete, anywhere)
--   Guards (triggers): section-month lock (every session, also those that bypass RLS; cascade-aware; serialised with a
--   lock being added — SHARE on expense.month_locks), broker ledger
--   (never overpaid at any date), one opening balance dated first, one vehicle per register entry, section / entry type
--   fixed, no future date; audit presence on every table; touch updated_at.
--   RLS: Expense is DEV-only — `private.can('expenses', …)` (Dev holds "*"; no role_permissions row is added).
--
-- What it changes in existing objects (the previous text is restored by the rollback script below):
--   * private.module_resource: adds 'Expense' → 'expenses' (every other mapping identical).
--   * private.changed_modules: never reports 'Expense' to a role without `expenses` (polling).
--   * audit.events "Read audit events" / audit.reviews "Owner and Dev read reviews" and "Owner and Dev review deletions":
--     Expense events (and reviews of them) only for roles holding `expenses` — every other module unchanged.
-- No existing table, row, grant or permission row is touched.
--
-- Rollback: supabase/scripts/08-rollback-expense-schema.sql (only while Expense holds no data AND has no audit event; with
-- either, only with the owner's approval and a backup — the plan §5.5). It drops the schema AND the eight trigger functions in `private` (the
-- schema's cascade leaves them behind), restores module_resource / changed_modules / the three audit policies exactly,
-- and checks the result, so this migration can be applied again unchanged. check:expense-db runs it.

begin;

/* ------------------------------------------------------------------ 0. guards */

do $$
begin
  if to_regclass('core.vehicles') is null or to_regclass('core.customers') is null or to_regclass('core.drivers') is null
     or to_regclass('core.companies') is null or to_regclass('core.vehicle_company_periods') is null
     or to_regclass('audit.events') is null or to_regclass('audit.reviews') is null or to_regclass('public.profiles') is null
     or to_regprocedure('private.require_parent_audit_event()') is null or to_regprocedure('private.touch_updated_at()') is null
     or to_regprocedure('private.can(text, text)') is null or to_regprocedure('private.month_open(date)') is null
     or to_regprocedure('private.today_ist()') is null or to_regprocedure('private.new_id(text)') is null
     or to_regprocedure('private.erp_role()') is null or to_regprocedure('private.is_dev()') is null
     or to_regprocedure('private.current_profile_id()') is null or to_regprocedure('private.is_owner_or_dev()') is null
     or to_regprocedure('private.changed_modules(timestamptz)') is null or to_regprocedure('private.module_resource(text)') is null then
    raise exception 'Expense migration stopped: apply every migration up to 20261127000000_driver_master_company_periods.sql first. Nothing was changed.';
  end if;
  if to_regnamespace('expense') is not null then
    raise exception 'Expense migration stopped: the expense schema already exists (applied fully or partly). Nothing was changed.';
  end if;
  if exists (select 1 from core.role_permissions where permission like 'expenses%') then
    raise exception 'Expense migration stopped: a role_permissions row for expenses exists — Expense must stay Dev-only. Nothing was changed.';
  end if;
  -- The two functions replaced below must be exactly the repository's current text (20261117000000 / 20261111000200).
  if (select md5(prosrc) from pg_proc where oid = to_regprocedure('private.module_resource(text)')) <> '51eb49b8bc5d0d6eb710f05644b6fd2b'
     or (select md5(prosrc) from pg_proc where oid = to_regprocedure('private.changed_modules(timestamptz)')) <> 'a99d47f13ad3a729cf7662902f34a91a' then
    raise exception 'Expense migration stopped: private.module_resource or private.changed_modules differs from the repository. Nothing was changed.';
  end if;
end $$;

/* ------------------------------------------------------------------ 1. schema and types */

create schema expense;
comment on schema expense is 'Expense module: Road Tax, Insurance, Fitness, Fines, Broker Charges (Dev-only until released).';
create type expense.section as enum ('ROAD_TAX', 'INSURANCE', 'FITNESS', 'FINE', 'BROKER');
create type expense.broker_entry_type as enum ('CHARGE', 'PAYMENT', 'BROUGHT_FORWARD');

/* ------------------------------------------------------------------ 2. tables, in dependency order */

create table expense.import_batches (
  id text primary key default private.new_id('imp'),
  source_label text not null check (btrim(source_label) <> ''),
  source_fingerprint text not null unique check (source_fingerprint ~ '^[0-9a-f]{64}$'),
  exported_at timestamptz,
  summary jsonb not null check (jsonb_typeof(summary) = 'object'),
  source_snapshot jsonb not null check (jsonb_typeof(source_snapshot) = 'object'),
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
comment on table expense.import_batches is 'One row per applied import of a browser backup (Phase 1 data). Never changed or deleted.';

create table expense.import_items (
  batch_id text not null references expense.import_batches (id) on delete cascade,
  source_collection text not null check (source_collection in ('expenses', 'brokers', 'expense_month_locks')),
  source_id text not null check (btrim(source_id) <> ''),
  outcome text not null check (outcome in ('IMPORTED', 'ALREADY_PRESENT', 'CONFLICT', 'REJECTED', 'SKIPPED')),
  target_id text,
  reason text not null default '',
  primary key (batch_id, source_collection, source_id)
);

create table expense.brokers (
  id text primary key default private.new_id('brk'),
  name text not null check (btrim(name) <> ''),
  name_key text generated always as (upper(btrim(regexp_replace(name, '\s+', ' ', 'g')))) stored,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint brokers_name_key unique (name_key)
);

create table expense.entries (
  id text primary key default private.new_id('exp'),
  section expense.section not null,
  date date not null,
  customer_id text references core.customers (id),
  company_code text references core.companies (code),
  company_confirmed boolean not null default false,
  description text not null default '',
  description_key text generated always as (upper(btrim(regexp_replace(description, '\s+', ' ', 'g')))) stored,
  amount numeric(14, 2) not null default 0 check (amount >= 0),
  remarks text not null default '',
  valid_from date,
  valid_till date,
  tax_type text not null default '',
  provider text not null default '',
  policy_no text not null default '',
  payment_mode text not null default '',
  payment_reference text not null default '',
  payment_status text check (payment_status in ('PAID', 'UNPAID')),
  payment_date date,
  driver_id text references core.drivers (id),
  entry_type expense.broker_entry_type,
  broker_name text not null default '',
  broker_key text generated always as (upper(btrim(regexp_replace(broker_name, '\s+', ' ', 'g')))) stored,
  broker_id text references expense.brokers (id),
  bill_no text not null default '',
  bill_no_key text generated always as (upper(btrim(regexp_replace(bill_no, '\s+', ' ', 'g')))) stored,
  purpose text not null default '',
  operating_company text not null default '',
  vehicle_count integer not null default 0 check (vehicle_count >= 0),
  paid_amount numeric(14, 2) not null default 0 check (paid_amount >= 0),
  request_id uuid,
  import_batch_id text references expense.import_batches (id),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint entries_request_id_key unique (request_id),
  constraint entries_period check ((valid_from is null) = (valid_till is null) and (valid_till is null or valid_till >= valid_from)),
  constraint entries_road_tax check (section <> 'ROAD_TAX' or (company_code is not null and btrim(description) <> '' and amount > 0)),
  constraint entries_insurance check (section <> 'INSURANCE' or (valid_from is not null and btrim(provider) <> '' and amount > 0)),
  constraint entries_fitness check (section <> 'FITNESS' or amount > 0),
  -- Fines (revision 5): Payment Reference optional, also when PAID (Phase 1); cleared when UNPAID (Phase 1 saves '').
  constraint entries_fine check (section <> 'FINE' or (btrim(tax_type) <> '' and payment_status is not null and amount > 0
    and (payment_status = 'PAID') = (payment_date is not null) and (payment_date is null or payment_date >= date)
    and (payment_status = 'PAID' or payment_reference = ''))),
  constraint entries_driver_only_fines check (section = 'FINE' or driver_id is null),
  constraint entries_broker_type check ((section = 'BROKER') = (entry_type is not null)),
  constraint entries_broker check (section <> 'BROKER' or
       (entry_type = 'CHARGE' and amount > 0 and paid_amount <= amount and btrim(description) <> '')
    or (entry_type = 'PAYMENT' and amount = 0 and paid_amount > 0)
    or (entry_type = 'BROUGHT_FORWARD' and amount > 0 and paid_amount = 0)),
  constraint entries_not_broker check (section = 'BROKER' or (broker_name = '' and broker_id is null and bill_no = '' and paid_amount = 0)),
  constraint entries_broker_named check (broker_id is null or broker_name <> '')
);
comment on table expense.entries is 'Every Expense entry (Road Tax, Insurance, Fitness, Fines, Broker bills / payments / opening balances). Month = date.';
create index entries_section_date_idx on expense.entries (section, date);
create index entries_description_idx on expense.entries (section, description_key);
create index entries_customer_idx on expense.entries (customer_id, date) where customer_id is not null;
create index entries_driver_idx on expense.entries (driver_id) where driver_id is not null;
create index entries_broker_idx on expense.entries (broker_key, date) where section = 'BROKER';
create unique index entries_bill_no_key on expense.entries (broker_key, bill_no_key) where entry_type = 'CHARGE' and bill_no_key <> '';
create unique index entries_one_opening on expense.entries (broker_key) where entry_type = 'BROUGHT_FORWARD';

create table expense.entry_vehicles (
  entry_id text not null references expense.entries (id) on delete cascade,
  line_no integer not null check (line_no >= 0),
  vehicle_id text not null references core.vehicles (id),
  primary key (entry_id, line_no),
  constraint entry_vehicles_once unique (entry_id, vehicle_id)
);
create index entry_vehicles_vehicle_idx on expense.entry_vehicles (vehicle_id);

create table expense.month_locks (
  id text not null default private.new_id('eml'),
  section expense.section not null,
  month text not null check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  locked_by uuid references public.profiles (id),
  locked_by_role public.erp_role,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (section, month),
  constraint month_locks_id_key unique (id)
);
comment on table expense.month_locks is 'Locked Expense section-months. Append-only: no unlock exists.';

/* ------------------------------------------------------------------ 3. functions */

-- Open = no lock row for that section-month. No role exemption (unlike the Monthly Sheet Lock).
create function private.expense_month_open(p_section expense.section, p_date date) returns boolean
language sql stable security definer set search_path = '' as $$
  select not exists (select 1 from expense.month_locks l where l.section = p_section and l.month = to_char(p_date, 'YYYY-MM'))
$$;

create function private.expense_lock_message(p_section expense.section, p_date date) returns text
language sql immutable set search_path = '' as $$
  select to_char(p_date, 'FMMonth YYYY') || ' is locked in '
    || case p_section when 'ROAD_TAX' then 'Road Tax' when 'INSURANCE' then 'Insurance' when 'FITNESS' then 'Fitness'
                      when 'FINE' then 'Fines' else 'Broker Charges' end
    || ' — its records are read-only. Nothing was saved.'
$$;

-- The section-month lock on every write, for every session (also those that bypass RLS). Cascade-aware on the child.
-- Concurrency: its first statement takes SHARE on the lock table. Adding a lock row needs ROW EXCLUSIVE, which conflicts
-- with SHARE, so a lock being added waits for every Expense write in progress to commit, and a write that starts while a
-- lock is being added waits for it to commit; the checks below then run on a fresh snapshot (READ COMMITTED) and see it.
-- Reads never wait. (Two sessions that each write entries AND add a lock in one transaction can deadlock: PostgreSQL
-- detects it and refuses one, nothing saved. The app's writes are one at a time — 'vishal-erp:write'.)
create function private.expense_month_lock_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  p_section expense.section;
  p_date date;
begin
  lock table expense.month_locks in share mode; -- see above: serialises with a lock being added
  if tg_table_name = 'entries' then
    if tg_op in ('UPDATE', 'DELETE') and not private.expense_month_open(old.section, old.date) then
      raise exception '%', private.expense_lock_message(old.section, old.date) using errcode = 'P0001';
    end if;
    if tg_op in ('INSERT', 'UPDATE') and not private.expense_month_open(new.section, new.date) then
      raise exception '%', private.expense_lock_message(new.section, new.date) using errcode = 'P0001';
    end if;
  else -- entry_vehicles: the parent entry's section-month
    if tg_op in ('UPDATE', 'DELETE') then
      select e.section, e.date into p_section, p_date from expense.entries e where e.id = old.entry_id;
      if not found then
        -- Parent already gone: only possible inside ON DELETE CASCADE of that parent, whose own trigger has checked
        -- (and allowed) the deletion. On UPDATE it can't happen with the foreign key in place: refuse.
        if tg_op = 'UPDATE' then
          raise exception 'A vehicle line can''t be changed without its entry. Nothing was saved.' using errcode = 'P0001';
        end if;
      elsif not private.expense_month_open(p_section, p_date) then
        raise exception '%', private.expense_lock_message(p_section, p_date) using errcode = 'P0001';
      end if;
    end if;
    if tg_op in ('INSERT', 'UPDATE') then
      select e.section, e.date into p_section, p_date from expense.entries e where e.id = new.entry_id;
      if not found then
        raise exception 'A vehicle line needs its entry. Nothing was saved.' using errcode = 'P0001';
      end if;
      if not private.expense_month_open(p_section, p_date) then
        raise exception '%', private.expense_lock_message(p_section, p_date) using errcode = 'P0001';
      end if;
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

-- A broker is never paid more than billed at any date (= firstOverpayment in src/domain/expenses.ts, same order).
-- Concurrency: the check runs at COMMIT under a per-broker advisory lock, so two sessions writing the same broker check
-- one after the other — the second (READ COMMITTED: each query sees what committed before it) sees the first's rows.
-- (The app's writes are already one at a time — the engine's 'vishal-erp:write' lock; this covers every other writer.)
create function private.broker_ledger_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  k text;
  r record;
  bal numeric := 0;
begin
  foreach k in array array_remove(array[
    case when tg_op <> 'INSERT' and old.section = 'BROKER' then old.broker_key end,
    case when tg_op <> 'DELETE' and new.section = 'BROKER' then new.broker_key end], null)
  loop
    perform pg_advisory_xact_lock(hashtext('vishal-erp:expense-broker:' || k));
    bal := 0;
    for r in
      select e.date, e.entry_type, e.amount, e.paid_amount from expense.entries e
      where e.section = 'BROKER' and e.broker_key = k
      order by e.date, case e.entry_type when 'BROUGHT_FORWARD' then 0 when 'CHARGE' then 1 else 2 end, e.created_at, e.id collate "C"
    loop
      bal := bal + case when r.entry_type = 'PAYMENT' then -r.paid_amount else r.amount - r.paid_amount end;
      if bal < -0.005 then
        raise exception 'This would leave the broker paid ₹% more than billed on %. Nothing was saved.', to_char(-bal, 'FM999999999990.00'), to_char(r.date, 'DD-MM-YYYY')
          using errcode = 'P0001';
      end if;
    end loop;
  end loop;
  return null;
end $$;

-- One opening balance per broker (unique index), dated on or before every other entry of that broker.
create function private.broker_opening_first() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  k text;
begin
  foreach k in array array_remove(array[
    case when tg_op <> 'INSERT' and old.section = 'BROKER' then old.broker_key end,
    case when tg_op <> 'DELETE' and new.section = 'BROKER' then new.broker_key end], null)
  loop
    perform pg_advisory_xact_lock(hashtext('vishal-erp:expense-broker:' || k)); -- as broker_ledger_guard
    if exists (
      select 1 from expense.entries o join expense.entries x on x.broker_key = o.broker_key and x.section = 'BROKER' and x.id <> o.id
      where o.section = 'BROKER' and o.entry_type = 'BROUGHT_FORWARD' and o.broker_key = k and x.date < o.date
    ) then
      raise exception 'A broker''s opening balance must be dated before every other entry of that broker. Nothing was saved.' using errcode = 'P0001';
    end if;
  end loop;
  return null;
end $$;

-- Road Tax / Insurance / Fitness / Fines: exactly one vehicle. Checks the entry as it exists at COMMIT; an entry that no
-- longer exists (deleted, its vehicle lines gone by cascade) has nothing to check.
create function private.entry_vehicle_count() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  eid text;
  s expense.section;
  n integer;
begin
  -- Field names differ per table, so each is read only on its own table.
  if tg_table_name = 'entries' then
    eid := new.id;
  elsif tg_op = 'DELETE' then
    eid := old.entry_id;
  else
    eid := new.entry_id;
  end if;
  select e.section into s from expense.entries e where e.id = eid;
  if not found or s = 'BROKER' then
    return null;
  end if;
  select count(*) into n from expense.entry_vehicles v where v.entry_id = eid;
  if n <> 1 then
    raise exception 'A Road Tax, Insurance, Fitness or Fine entry names exactly one vehicle. Nothing was saved.' using errcode = 'P0001';
  end if;
  return null;
end $$;

-- An entry's vehicle line removed by a role without `expenses:delete` (an edit that changes the vehicles): only inside the
-- entry's audited edit whose "before" snapshot names that vehicle — as private.vehicle_driver_period_delete_guard().
create function private.entry_vehicle_delete_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.erp_role() is null or private.can('expenses', 'delete') then
    return null;
  end if;
  if not exists (
    select 1 from audit.events e
    where e.txid = txid_current() and e.record_id = old.entry_id and e.action = 'UPDATED' and e.after is not null
      and e.before @> jsonb_build_object('vehicleIds', jsonb_build_array(old.vehicle_id))
  ) then
    raise exception 'Only the Owner and Dev can delete records: an expense.entry_vehicles row (entry %) is removed only by an audited edit of its entry.', old.entry_id
      using errcode = 'insufficient_privilege';
  end if;
  return null;
end $$;

-- A record keeps its section and its kind (bill / payment / opening).
create function private.expense_entry_fixed() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.section is distinct from old.section or new.entry_type is distinct from old.entry_type then
    raise exception 'An Expense record keeps its section and its type. Nothing was saved.' using errcode = 'P0001';
  end if;
  return new;
end $$;

-- A broker entry's broker_id follows its broker name (Phase 1 stores the name; an older spelling not in the list, or no
-- name, keeps broker_id null). Set before the row is written, so no second update (created_at / updated_at untouched).
create function private.expense_broker_link() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.broker_id := case when new.section = 'BROKER' and btrim(new.broker_name) <> '' then
    (select b.id from expense.brokers b where b.name_key = upper(btrim(regexp_replace(new.broker_name, '\s+', ' ', 'g')))) end;
  return new;
end $$;

-- No future business date (India time, the server's clock).
create function private.expense_not_future() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.date > private.today_ist() or new.payment_date > private.today_ist() then
    raise exception 'A date can''t be in the future. Nothing was saved.' using errcode = 'P0001';
  end if;
  return new;
end $$;

revoke all on function private.expense_month_open(expense.section, date), private.expense_lock_message(expense.section, date),
  private.expense_month_lock_guard(), private.broker_ledger_guard(), private.broker_opening_first(), private.entry_vehicle_count(),
  private.expense_entry_fixed(), private.expense_not_future(), private.expense_broker_link(), private.entry_vehicle_delete_guard() from public, anon, authenticated;
grant execute on function private.expense_month_open(expense.section, date) to authenticated, service_role;

/* ------------------------------------------------------------------ 4. triggers */

create trigger import_batches_touch before update on expense.import_batches for each row execute function private.touch_updated_at();
create trigger brokers_touch before update on expense.brokers for each row execute function private.touch_updated_at();
create trigger entries_touch before update on expense.entries for each row execute function private.touch_updated_at();
create trigger month_locks_touch before update on expense.month_locks for each row execute function private.touch_updated_at();

create constraint trigger import_batches_require_audit after insert or update or delete on expense.import_batches
  deferrable initially deferred for each row execute function private.require_parent_audit_event('id');
create constraint trigger import_items_require_audit after insert or update or delete on expense.import_items
  deferrable initially deferred for each row execute function private.require_parent_audit_event('batch_id');
create constraint trigger brokers_require_audit after insert or update or delete on expense.brokers
  deferrable initially deferred for each row execute function private.require_parent_audit_event('id');
create constraint trigger entries_require_audit after insert or update or delete on expense.entries
  deferrable initially deferred for each row execute function private.require_parent_audit_event('id');
create constraint trigger entry_vehicles_require_audit after insert or update or delete on expense.entry_vehicles
  deferrable initially deferred for each row execute function private.require_parent_audit_event('entry_id');
create constraint trigger month_locks_require_audit after insert or update or delete on expense.month_locks
  deferrable initially deferred for each row execute function private.require_parent_audit_event('id');

create trigger entries_month_lock before insert or update or delete on expense.entries for each row execute function private.expense_month_lock_guard();
create trigger entry_vehicles_month_lock before insert or update or delete on expense.entry_vehicles for each row execute function private.expense_month_lock_guard();
create trigger entries_fixed before update on expense.entries for each row execute function private.expense_entry_fixed();
create trigger entries_not_future before insert or update on expense.entries for each row execute function private.expense_not_future();
create trigger entries_broker_link before insert or update of broker_name, section on expense.entries for each row execute function private.expense_broker_link();
create constraint trigger entries_broker_ledger after insert or update or delete on expense.entries
  deferrable initially deferred for each row execute function private.broker_ledger_guard();
create constraint trigger entries_opening_first after insert or update or delete on expense.entries
  deferrable initially deferred for each row execute function private.broker_opening_first();
create constraint trigger entries_vehicle_count after insert or update on expense.entries
  deferrable initially deferred for each row execute function private.entry_vehicle_count();
create constraint trigger entry_vehicles_vehicle_count after insert or update or delete on expense.entry_vehicles
  deferrable initially deferred for each row execute function private.entry_vehicle_count();
create constraint trigger entry_vehicles_edit_delete after delete on expense.entry_vehicles
  deferrable initially deferred for each row execute function private.entry_vehicle_delete_guard();

/* ------------------------------------------------------------------ 5. grants and RLS (Dev-only: private.can('expenses', …)) */

revoke all on all tables in schema expense from public, anon, authenticated;
grant usage on schema expense to authenticated, service_role;
grant all on all tables in schema expense to service_role;
grant select, insert, update, delete on expense.entries to authenticated;
grant select, insert, delete on expense.entry_vehicles to authenticated;
grant select, insert on expense.brokers, expense.month_locks, expense.import_batches, expense.import_items to authenticated;

alter table expense.import_batches enable row level security;
alter table expense.import_items enable row level security;
alter table expense.brokers enable row level security;
alter table expense.entries enable row level security;
alter table expense.entry_vehicles enable row level security;
alter table expense.month_locks enable row level security;

create policy "Read Expense entries" on expense.entries for select to authenticated using ((select private.can('expenses', 'view')));
create policy "Add Expense entries" on expense.entries for insert to authenticated
  with check ((select private.can('expenses', 'create')) and private.expense_month_open(section, date) and private.month_open(date));
create policy "Edit Expense entries" on expense.entries for update to authenticated
  using ((select private.can('expenses', 'edit')) and private.expense_month_open(section, date) and private.month_open(date))
  with check (private.expense_month_open(section, date) and private.month_open(date));
create policy "Delete Expense entries" on expense.entries for delete to authenticated
  using ((select private.can('expenses', 'delete')) and private.expense_month_open(section, date) and private.month_open(date));

create policy "Read Expense entry vehicles" on expense.entry_vehicles for select to authenticated
  using (exists (select 1 from expense.entries e where e.id = entry_id));
create policy "Add Expense entry vehicles" on expense.entry_vehicles for insert to authenticated
  with check (((select private.can('expenses', 'create')) or (select private.can('expenses', 'edit')))
    and exists (select 1 from expense.entries e where e.id = entry_id and private.expense_month_open(e.section, e.date)));
create policy "Remove Expense entry vehicles" on expense.entry_vehicles for delete to authenticated
  using ((select private.can('expenses', 'edit'))
    and exists (select 1 from expense.entries e where e.id = entry_id and private.expense_month_open(e.section, e.date)));

create policy "Read brokers" on expense.brokers for select to authenticated using ((select private.can('expenses', 'view')));
create policy "Add brokers" on expense.brokers for insert to authenticated with check ((select private.can('expenses', 'create')));

create policy "Read Expense month locks" on expense.month_locks for select to authenticated using ((select private.can('expenses', 'view')));
create policy "Lock Expense months" on expense.month_locks for insert to authenticated
  with check ((select private.can('expenses', 'edit')) and month <= to_char(private.today_ist(), 'YYYY-MM')
    and locked_by_role = (select private.erp_role()) and locked_by = (select private.current_profile_id()));

create policy "Read import batches" on expense.import_batches for select to authenticated using ((select private.is_dev()));
create policy "Record import batches" on expense.import_batches for insert to authenticated
  with check ((select private.is_dev()) and created_by = (select private.current_profile_id()));
create policy "Read import items" on expense.import_items for select to authenticated using ((select private.is_dev()));
create policy "Record import items" on expense.import_items for insert to authenticated with check ((select private.is_dev()));

/* ------------------------------------------------------------------ 6. audit: Expense events only for roles holding `expenses` */

create or replace function private.module_resource(module text) returns text
language sql immutable set search_path = '' as $$
  select case module
    when 'Diesel' then 'diesel' when 'AdBlue' then 'adblue' when 'Diesel Tanker' then 'diesel' when 'Fuel Stations' then 'diesel'
    when 'Payments' then 'payments' when 'Customers' then 'customers' when 'Vehicles' then 'vehicles'
    when 'Drivers' then 'settings' when 'Trips' then 'trips' when 'Invoices' then 'invoices' when 'Settings' then 'settings'
    when 'Tyre' then 'tyres'
    when 'Expense' then 'expenses'
    else 'audit' end
$$;

-- Security definer (bypasses RLS), so it filters Expense itself: polling never tells a role without `expenses`.
create or replace function private.changed_modules(p_since timestamptz) returns setof text
language sql stable security definer set search_path = '' as $$
  select distinct e.module from audit.events e
  where e.at > p_since - interval '2 minutes'
    and (e.module <> 'Expense' or private.can('expenses', 'view'))
    and ((select private.can('audit', 'view')) or private.can(private.module_resource(e.module), 'view')
         or (e.module in ('Customers', 'Vehicles', 'Month Lock') and (select private.can('diesel', 'view'))))
$$;

drop policy "Read audit events" on audit.events;
create policy "Read audit events" on audit.events for select to authenticated
  using ((select private.can('audit', 'view')) and (module <> 'Expense' or (select private.can('expenses', 'view'))));

drop policy "Owner and Dev read reviews" on audit.reviews;
create policy "Owner and Dev read reviews" on audit.reviews for select to authenticated
  using ((select private.can('audit', 'view')) and exists (select 1 from audit.events e where e.id = event_id));

drop policy "Owner and Dev review deletions" on audit.reviews;
create policy "Owner and Dev review deletions" on audit.reviews for insert to authenticated
  with check ((select private.is_owner_or_dev()) and actor_user_id = (select private.current_profile_id()) and actor_role = (select private.erp_role())
    and exists (select 1 from audit.events e where e.id = event_id));

commit;
