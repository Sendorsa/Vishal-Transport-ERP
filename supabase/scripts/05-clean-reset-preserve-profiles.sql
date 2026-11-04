-- DESTRUCTIVE — Production clean reset that preserves every account (owner's authorisation, 4 Nov 2026).
-- Project dqnoducqiootfvkzskhu, SQL Editor, default postgres role. Run ONLY after 04-inventory.sql and a downloaded
-- 02-backup-business-data.sql. Two independent parts; each is ONE transaction (any error = nothing changed).
--
-- NEVER TOUCHED: public.profiles, auth.* (users, Google identities, sessions), roles, grants, RLS policies, schemas,
--   tables, columns, indexes, constraints, functions, triggers, migration history. Nothing is dropped or truncated, and no
--   statement cascades into accounts: deletes only run on business tables, and no foreign key from public.profiles
--   points at a business table (04-inventory.sql → profile_fks shows this).
-- KEPT as system configuration (the app can't start or authorise without them — see FULL_APPLICATION_AUDIT_REPORT.md):
--   core.role_permissions (RLS: private.can), core.companies (VT / VTHPL: every company_code, invoice and voucher prefix),
--   core.vehicle_types and finance.payment_categories (reference lists; DIESEL_SETTLEMENT is every station payment),
--   core.app_settings (the single tax row), fuel.fuel_stations 'dv_tanker' (the internal tanker source).
--
-- PART A — clears every business row. The database requires an audit event for every change in the same transaction
--   (no change without its event), so each removed row gets a SYSTEM "DELETED" event with its full snapshot, then one
--   DATA_RESET event. Refuses to run if the database has a table this script doesn't know (inspect it first).
-- PART B — OPTIONAL, separate, after Part A: clears the audit trail. The trail is append-only for every role, so this
--   switches the append-only triggers off INSIDE the transaction only, deletes, switches them back on and verifies they
--   are on before committing (an error rolls the switch back too). Mode BUSINESS keeps the "Accounts" history (who
--   created / changed each user account); mode ALL removes it too. Leaves one DATA_RESET marker.
--
-- TO RUN A PART: select from its "begin;" to its "commit;", replace TYPE-PROJECT-REF with the project ref
-- (and, for Part B, TYPE-MODE with BUSINESS or ALL), and Run. A success ends with "Success. No rows returned".

/* ================================================================== PART A — business data */
begin;
select set_config('vt.confirm_reset', 'TYPE-PROJECT-REF', true);
do $$
declare
  why constant text := 'Production clean reset, accounts preserved (owner-approved, 4 Nov 2026)';
  -- Children before parents (foreign keys). Every one is emptied (fuel stations: all but dv_tanker).
  cleared constant text[] := array['finance.payment_allocations', 'finance.payments', 'billing.invoice_line_trips', 'billing.invoice_lines', 'billing.invoices',
    'ops.trips', 'fuel.adblue_entries', 'fuel.adblue_purchases', 'fuel.diesel_entries', 'fuel.tanker_loads', 'fuel.tanker_transfers', 'fuel.tanker_adjustments',
    'fuel.tankers', 'core.vehicle_assignments', 'core.vehicle_status_periods', 'core.customer_route_rates', 'core.customer_pricing', 'core.customer_status_periods',
    'core.month_locks', 'core.vehicles', 'core.drivers', 'core.customers', 'fuel.fuel_stations'];
  -- Tables whose rows carry their own audit record id (child rows are covered by their parent's event).
  audited constant text[] := array['finance.payments', 'billing.invoices', 'ops.trips', 'fuel.adblue_entries', 'fuel.adblue_purchases', 'fuel.diesel_entries',
    'fuel.tanker_loads', 'fuel.tanker_transfers', 'fuel.tanker_adjustments', 'fuel.tankers', 'core.month_locks', 'core.vehicles', 'core.drivers', 'core.customers',
    'fuel.fuel_stations'];
  kept constant text[] := array['public.profiles', 'core.role_permissions', 'core.companies', 'core.vehicle_types', 'core.app_settings', 'finance.payment_categories',
    'audit.events', 'audit.reviews'];
  t text;
  n bigint;
  unknown text;
  profiles_before text := (select md5(coalesce(string_agg(concat_ws('|', id, user_id, email, role, status, full_name, activated_at, updated_at), ',' order by id), '')) from public.profiles);
  users_before text := (select md5(coalesce(string_agg(id::text, ',' order by id), '')) from auth.users);
  identities_before text := (select md5(coalesce(string_agg(id::text, ',' order by id), '')) from auth.identities);
  config_before text := (select md5(concat((select string_agg(to_jsonb(x)::text, ',' order by x.code) from core.companies x), (select string_agg(to_jsonb(x)::text, ',' order by x.code) from core.vehicle_types x),
    (select string_agg(to_jsonb(x)::text, ',' order by x.code) from finance.payment_categories x), (select string_agg(to_jsonb(x)::text, ',') from core.app_settings x),
    (select string_agg(to_jsonb(x)::text, ',' order by to_jsonb(x)::text) from core.role_permissions x))));
begin
  if current_setting('vt.confirm_reset', true) is distinct from 'dqnoducqiootfvkzskhu' then
    raise exception 'Not confirmed: replace TYPE-PROJECT-REF with the project ref (dqnoducqiootfvkzskhu). Nothing was changed.';
  end if;
  select string_agg(format('%I.%I', table_schema, table_name), ', ') into unknown
  from information_schema.tables
  where table_type = 'BASE TABLE'
    and table_schema in (select nspname from pg_namespace where nspname not like 'pg\_%' and nspname not in ('information_schema', 'auth', 'storage', 'realtime', '_realtime', 'vault', 'extensions', 'graphql', 'graphql_public', 'net', 'supabase_functions', 'supabase_migrations', 'cron', 'pgsodium', 'pgsodium_masks', 'pgbouncer', '_analytics', 'topology', 'pgmq'))
    and format('%I.%I', table_schema, table_name) <> all (cleared || kept);
  if unknown is not null then
    raise exception 'Tables this script does not know: % — inspect them first. Nothing was changed.', unknown;
  end if;

  -- One SYSTEM deletion event per business row, with its full snapshot (checked at COMMIT: no change without its event).
  foreach t in array audited loop
    execute format(
      'insert into audit.events (actor_kind, action, module, record_type, record_id, label, before, reason, note)
       select ''SYSTEM'', ''DELETED'', ''System'', %L, x.%I, ''Clean reset'', to_jsonb(x), %L, ''Business data cleared; accounts preserved''
       from %s x %s',
      t, case when t = 'core.month_locks' then 'month' else 'id' end, why, t, case when t = 'fuel.fuel_stations' then 'where not x.is_tanker_source' else '' end);
  end loop;

  -- Invoiced trips are locked to their invoice: release them first (an invoice_id-only change, as cancelling does).
  update ops.trips set invoice_id = null where invoice_id is not null;

  foreach t in array cleared loop
    execute format('delete from %s %s', t, case when t = 'fuel.fuel_stations' then 'where not is_tanker_source' else '' end);
    get diagnostics n = row_count;
    raise notice '% rows removed from %', n, t;
  end loop;

  insert into audit.events (actor_kind, action, module, record_type, record_id, label, reason, note)
  values ('SYSTEM', 'DATA_RESET', 'System', 'Data', 'workspace', 'Business data cleared (accounts preserved)', why, 'supabase/scripts/05-clean-reset-preserve-profiles.sql — part A');

  -- Proven, not assumed: every business table is empty; accounts and configuration are exactly as they were.
  foreach t in array cleared loop
    execute format('select count(*) from %s %s', t, case when t = 'fuel.fuel_stations' then 'where not is_tanker_source' else '' end) into n;
    if n <> 0 then raise exception '% still has % rows (row level security on the owner?) — aborting, nothing changed.', t, n; end if;
  end loop;
  if (select md5(coalesce(string_agg(concat_ws('|', id, user_id, email, role, status, full_name, activated_at, updated_at), ',' order by id), '')) from public.profiles) <> profiles_before
     or (select md5(coalesce(string_agg(id::text, ',' order by id), '')) from auth.users) <> users_before
     or (select md5(coalesce(string_agg(id::text, ',' order by id), '')) from auth.identities) <> identities_before then
    raise exception 'A profile, auth user or identity would change — aborting, nothing changed.';
  end if;
  if (select md5(concat((select string_agg(to_jsonb(x)::text, ',' order by x.code) from core.companies x), (select string_agg(to_jsonb(x)::text, ',' order by x.code) from core.vehicle_types x),
      (select string_agg(to_jsonb(x)::text, ',' order by x.code) from finance.payment_categories x), (select string_agg(to_jsonb(x)::text, ',') from core.app_settings x),
      (select string_agg(to_jsonb(x)::text, ',' order by to_jsonb(x)::text) from core.role_permissions x)))) <> config_before then
    raise exception 'System configuration would change — aborting, nothing changed.';
  end if;
  if not exists (select 1 from fuel.fuel_stations where id = 'dv_tanker' and is_tanker_source) then
    raise exception 'The internal tanker source dv_tanker is missing — aborting, nothing changed.';
  end if;
end $$;
commit;

/* ================================================================== PART B — the audit trail (optional, after Part A) */
begin;
select set_config('vt.confirm_reset', 'TYPE-PROJECT-REF', true);
select set_config('vt.audit_clear', 'TYPE-MODE', true); -- BUSINESS (keep the Accounts history) or ALL
do $$
declare
  mode constant text := current_setting('vt.audit_clear', true);
  profiles_before text := (select md5(coalesce(string_agg(concat_ws('|', id, user_id, email, role, status, full_name, activated_at, updated_at), ',' order by id), '')) from public.profiles);
  ev bigint;
  rv bigint;
begin
  if current_setting('vt.confirm_reset', true) is distinct from 'dqnoducqiootfvkzskhu' then
    raise exception 'Not confirmed: replace TYPE-PROJECT-REF with the project ref (dqnoducqiootfvkzskhu). Nothing was changed.';
  end if;
  if mode is null or mode not in ('BUSINESS', 'ALL') then
    raise exception 'Choose the mode: replace TYPE-MODE with BUSINESS (keep the Accounts history) or ALL. Nothing was changed.';
  end if;
  if exists (select 1 from core.customers) or exists (select 1 from core.vehicles) or exists (select 1 from fuel.diesel_entries) or exists (select 1 from finance.payments)
     or exists (select 1 from fuel.fuel_stations where not is_tanker_source) then
    raise exception 'Business data is still there — run Part A first. Nothing was changed.';
  end if;

  -- The append-only guard is off only inside this transaction; it is switched back on below, and verified.
  alter table audit.reviews disable trigger reviews_append_only;
  alter table audit.events disable trigger events_append_only;
  delete from audit.reviews r where mode = 'ALL' or exists (select 1 from audit.events e where e.id = r.event_id and e.module <> 'Accounts');
  get diagnostics rv = row_count;
  delete from audit.events where mode = 'ALL' or module <> 'Accounts';
  get diagnostics ev = row_count;
  alter table audit.events enable trigger events_append_only;
  alter table audit.reviews enable trigger reviews_append_only;
  raise notice '% audit events and % reviews removed (mode %)', ev, rv, mode;

  insert into audit.events (actor_kind, action, module, record_type, record_id, label, reason, note)
  values ('SYSTEM', 'DATA_RESET', 'System', 'Data', 'workspace',
          case when mode = 'ALL' then 'Audit history cleared' else 'Business audit history cleared (account history kept)' end,
          'Production clean reset, accounts preserved (owner-approved, 4 Nov 2026)', 'supabase/scripts/05-clean-reset-preserve-profiles.sql — part B, mode ' || mode);

  if (select count(*) from pg_trigger where tgname in ('events_append_only', 'events_no_truncate', 'reviews_append_only', 'reviews_no_truncate')
        and tgrelid in ('audit.events'::regclass, 'audit.reviews'::regclass) and tgenabled = 'O') <> 4 then
    raise exception 'The audit trail''s append-only protection is not fully back on — aborting, nothing changed.';
  end if;
  if (select md5(coalesce(string_agg(concat_ws('|', id, user_id, email, role, status, full_name, activated_at, updated_at), ',' order by id), '')) from public.profiles) <> profiles_before then
    raise exception 'A profile would change — aborting, nothing changed.';
  end if;
  if mode = 'BUSINESS' and exists (select 1 from audit.events where module not in ('Accounts', 'System')) then
    raise exception 'Business audit events remain — aborting, nothing changed.';
  end if;
end $$;
commit;

-- AFTER: run 04-inventory.sql again and compare (accounts fingerprints must be identical; business tables 0).
