-- READ-ONLY. Gate G0 (docs/SUPABASE_SHARED_DATA_MIGRATION_PLAN.md §1): what the Production database really holds.
-- Run in the Supabase dashboard → SQL Editor of project dqnoducqiootfvkzskhu (check the URL first). Changes nothing.
-- Uses pg_catalog (not information_schema, which hides tables the querying role can't use).

-- 1. What physically exists.
select json_build_object(
  'database', current_database(),
  'run_as', current_user,
  'server_version', current_setting('server_version'),
  'erp_schemas', (select json_agg(nspname order by nspname) from pg_namespace where nspname in ('core', 'fuel', 'finance', 'audit', 'private', 'ops', 'billing')),
  'tables', (select json_agg(n.nspname || '.' || c.relname order by n.nspname, c.relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where c.relkind in ('r', 'p') and n.nspname in ('public', 'core', 'fuel', 'finance', 'audit', 'ops', 'billing')),
  'rls_off', (select json_agg(n.nspname || '.' || c.relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where c.relkind = 'r' and not c.relrowsecurity and n.nspname in ('core', 'fuel', 'finance', 'audit', 'ops', 'billing')),
  'fuel_like_names_anywhere', (select json_agg(n.nspname || '.' || c.relname order by 1) from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where c.relkind in ('r', 'p', 'v') and c.relname ~* '(fuel|pump|station|tanker|diesel|adblue)' and n.nspname not in ('pg_catalog', 'information_schema')),
  'approx_rows', (select json_agg(schemaname || '.' || relname || '=' || n_live_tup order by schemaname, relname) from pg_stat_user_tables
             where schemaname in ('core', 'fuel', 'finance', 'audit', 'public', 'ops', 'billing')),
  'migrations_table_exists', to_regclass('supabase_migrations.schema_migrations') is not null,
  'erp_server_role', exists (select 1 from pg_roles where rolname = 'erp_server')
) as g0;

-- 2. What the CLI recorded (only if migrations_table_exists is true above).
-- select version, name from supabase_migrations.schema_migrations order by version;

-- 3. Accounts and identities that a reset must never touch (counts only, no emails).
-- select role, status, count(*) from public.profiles group by 1, 2 order by 1, 2;
-- select provider, count(*) from auth.identities group by 1;
-- select count(*) as auth_users from auth.users;

-- 4. Foreign keys pointing INTO accounts / auth (a business delete must never cascade into these).
-- select conrelid::regclass as from_table, confrelid::regclass as to_table, conname, confdeltype as on_delete
-- from pg_constraint where contype = 'f' and confrelid in ('public.profiles'::regclass, 'auth.users'::regclass) order by 1;
