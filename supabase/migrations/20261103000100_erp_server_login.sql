-- The Next.js server's database login (M-1, docs/SUPABASE_SHARED_DATA_MIGRATION_PLAN.md §10).
-- NOINHERIT: it holds no table privilege of its own. Every request runs `SET LOCAL ROLE authenticated` with the
-- verified user's claims, so Row Level Security always applies — the server never bypasses RLS and never uses the
-- service-role / secret key.
-- The password is NOT set here (never in git). After applying, the administrator runs once in the SQL editor:
--   alter role erp_server with password '<generated secret>';
-- and stores the pooler connection string (user erp_server.<project-ref>, port 6543) as SUPABASE_DB_URL in Vercel.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'erp_server') then
    create role erp_server login noinherit;
  end if;
end $$;
grant authenticated to erp_server;
comment on role erp_server is 'Next.js server login. No privileges until SET ROLE authenticated (RLS applies). Password set outside git.';
