-- READ-ONLY. Inventory before (and after) the clean reset that preserves every account (05-clean-reset-preserve-profiles.sql).
-- Run in the SQL Editor of project dqnoducqiootfvkzskhu; copy the single result cell ("inventory") into the chat.
-- It contains no email, name or key: accounts are summarised as counts and fingerprints (md5), so "before" and "after"
-- can be compared exactly without exposing them.
--   tables          every base table in every non-Supabase schema, with its exact row count
--   unknown_tables  tables the reset script doesn't know (it refuses to run while any exist — inspect them first)
--   account_fks     every foreign key that points at public.profiles or auth.users, and its ON DELETE action
--   profile_fks     every foreign key FROM public.profiles (a cascade from business data into accounts would show here)
--   accounts        profile counts by role / status, and fingerprints of profiles, auth users and Google identities
--   audit_guards    whether the audit trail's append-only triggers are enabled ('O' = enabled)
select jsonb_build_object(
  'project', 'dqnoducqiootfvkzskhu',
  'at', now(),
  'tables', (
    select jsonb_object_agg(t, n order by t) from (
      select format('%I.%I', table_schema, table_name) as t,
             (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text::bigint as n
      from information_schema.tables
      where table_type = 'BASE TABLE'
        and table_schema not in ('pg_catalog', 'information_schema', 'auth', 'storage', 'realtime', '_realtime', 'vault', 'extensions', 'graphql', 'graphql_public',
                                 'net', 'supabase_functions', 'supabase_migrations', 'cron', 'pgsodium', 'pgsodium_masks', 'pgbouncer', '_analytics', 'topology', 'pgmq')
    ) x
  ),
  'unknown_tables', (
    select coalesce(jsonb_agg(format('%I.%I', table_schema, table_name) order by 1), '[]'::jsonb)
    from information_schema.tables
    where table_type = 'BASE TABLE'
      and table_schema in (select nspname from pg_namespace where nspname not like 'pg\_%' and nspname not in ('information_schema', 'auth', 'storage', 'realtime', '_realtime', 'vault', 'extensions', 'graphql', 'graphql_public', 'net', 'supabase_functions', 'supabase_migrations', 'cron', 'pgsodium', 'pgsodium_masks', 'pgbouncer', '_analytics', 'topology', 'pgmq'))
      and format('%I.%I', table_schema, table_name) not in (
        'public.profiles', 'core.role_permissions', 'core.companies', 'core.vehicle_types', 'core.app_settings', 'finance.payment_categories', 'audit.events', 'audit.reviews',
        'core.customers', 'core.customer_status_periods', 'core.customer_pricing', 'core.customer_route_rates', 'core.drivers', 'core.vehicles', 'core.vehicle_status_periods',
        'core.vehicle_assignments', 'core.month_locks', 'fuel.fuel_stations', 'fuel.tankers', 'fuel.diesel_entries', 'fuel.tanker_loads', 'fuel.tanker_transfers',
        'fuel.tanker_adjustments', 'fuel.adblue_purchases', 'fuel.adblue_entries', 'finance.payments', 'finance.payment_allocations', 'ops.trips', 'billing.invoices',
        'billing.invoice_lines', 'billing.invoice_line_trips')
  ),
  'account_fks', (
    select coalesce(jsonb_agg(jsonb_build_object('from', (select n.nspname || '.' || c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.oid = conrelid), 'to', (select n.nspname || '.' || c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.oid = confrelid), 'on_delete', confdeltype::text) order by conrelid::regclass::text), '[]'::jsonb)
    from pg_constraint where contype = 'f' and confrelid in ('public.profiles'::regclass, 'auth.users'::regclass)
  ),
  'profile_fks', (
    select coalesce(jsonb_agg(jsonb_build_object('to', (select n.nspname || '.' || c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.oid = confrelid), 'on_delete', confdeltype::text)), '[]'::jsonb)
    from pg_constraint where contype = 'f' and conrelid = 'public.profiles'::regclass
  ),
  'accounts', jsonb_build_object(
    'profiles', (select count(*) from public.profiles),
    'by_role_status', (select jsonb_object_agg(k, n) from (select role || '/' || status as k, count(*) as n from public.profiles group by 1) x),
    'profiles_md5', (select md5(string_agg(concat_ws('|', id, user_id, email, role, status, full_name, activated_at, updated_at), ',' order by id)) from public.profiles),
    'auth_users', (select count(*) from auth.users),
    'auth_users_md5', (select md5(string_agg(concat_ws('|', id, email, updated_at, last_sign_in_at is not null), ',' order by id)) from auth.users),
    'identities', (select count(*) from auth.identities),
    'identities_md5', (select md5(string_agg(concat_ws('|', id, user_id, provider), ',' order by id)) from auth.identities),
    'profiles_without_auth_user', (select count(*) from public.profiles p where p.user_id is not null and not exists (select 1 from auth.users u where u.id = p.user_id))
  ),
  'audit_guards', (select jsonb_object_agg(tgname, tgenabled::text) from pg_trigger where tgrelid in ('audit.events'::regclass, 'audit.reviews'::regclass) and not tgisinternal),
  'audit_by_module', (select jsonb_object_agg(module, n) from (select module, count(*) as n from audit.events group by 1) x),
  'storage_objects', (select case when to_regclass('storage.objects') is null then null else (xpath('/row/c/text()', query_to_xml('select count(*) as c from storage.objects', false, true, '')))[1]::text::bigint end),
  'migrations', (select case when to_regclass('supabase_migrations.schema_migrations') is null then null else (xpath('/row/c/text()', query_to_xml('select count(*) as c from supabase_migrations.schema_migrations', false, true, '')))[1]::text::bigint end)
) as inventory;
