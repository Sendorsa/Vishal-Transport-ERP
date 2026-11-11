-- Pre-flight for the AdBlue profiles: is Production ready for 20261111000100_erp_roles_adblue.sql (A) and
-- 20261111000200_adblue_profiles.sql (B)? Run BEFORE A. Run together with 05-post-apply-fingerprint.sql.
-- READ-ONLY: a single SELECT over the system catalogs, public.profiles and core.role_permissions. It writes nothing,
-- creates nothing, locks nothing beyond a normal read and changes no permission. No email, name or other personal data
-- is shown (counts only). Safe to run in the Supabase SQL Editor of project dqnoducqiootfvkzskhu (check the URL first).
--
-- Output: 9 rows — check_no | check_name | expected | actual | status.
--   OK   = as required.
--   INFO = row 2 only: whether the month-lock migration 20261111000000 is in. Either answer is fine for A and B, but it
--          must agree with 05-post-apply-fingerprint.sql (not applied: 769 OK; applied: 3 DIFFERENT + 2 EXTRA, all
--          month-lock objects).
--   STOP = do not apply A or B. Each STOP condition:
--     1 not the postgres database                      → wrong database / project
--     3 erp_role has values other than the three        → A (or something else) already changed the role type
--     4 core.profile_customer_access exists             → B was already applied, fully or partly
--     5 any of B's six functions exists                 → B was already applied, fully or partly
--     6 any adblue / TATA_ADBLUE / ADBLUE permission row → B was already applied, or rows were added by hand
--     7 fewer than 10 of the policies B replaces        → B's DROP POLICY would fail; Production differs from the repository
--     8 an account with a role other than the three     → unexpected roles in public.profiles
--     9 no ACTIVE DEV                                   → nobody could create or set up the new accounts afterwards
select check_no, check_name, expected, actual,
       case when check_no = 2 then 'INFO' when actual = expected then 'OK' else 'STOP' end as status
from (values
  (1, 'database', 'postgres', current_database()),
  (2, 'month-lock migration 20261111000000', 'applied or not applied',
      case when to_regprocedure('private.can_set_month_lock()') is null then 'not applied' else 'applied' end),
  (3, 'erp_role values (A not applied yet)', 'OWNER,DEV,EMPLOYEE',
      (select string_agg(e.enumlabel, ',' order by e.enumsortorder) from pg_enum e where e.enumtypid = to_regtype('public.erp_role'))),
  (4, 'core.profile_customer_access (B not applied yet)', 'absent',
      case when to_regclass('core.profile_customer_access') is null then 'absent' else 'present' end),
  (5, 'B functions absent', '0',
      (select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where (n.nspname, p.proname) in (('private', 'customer_in_scope'), ('private', 'changed_modules'), ('private', 'write_access_event'),
                                        ('private', 'customer_access_require_audit'), ('public', 'set_customer_access'), ('public', 'list_customer_access')))),
  (6, 'adblue / profile permission rows', '0',
      (select count(*)::text from core.role_permissions where permission like 'adblue%' or role::text in ('TATA_ADBLUE', 'ADBLUE'))),
  (7, 'policies B replaces (exact names)', '10',
      (select count(*)::text from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace
       where (n.nspname, c.relname, p.polname) in (
         ('fuel', 'adblue_entries', 'Read AdBlue entries'), ('fuel', 'adblue_entries', 'Add AdBlue entries'),
         ('fuel', 'adblue_entries', 'Edit AdBlue entries'), ('fuel', 'adblue_entries', 'Delete AdBlue entries'),
         ('fuel', 'adblue_purchases', 'Read AdBlue purchases'), ('fuel', 'adblue_purchases', 'Add AdBlue purchases'),
         ('fuel', 'adblue_purchases', 'Edit AdBlue purchases'), ('fuel', 'adblue_purchases', 'Delete AdBlue purchases'),
         ('audit', 'events', 'Read audit events'), ('finance', 'payments', 'Read payments')))),
  (8, 'accounts with a role other than OWNER / DEV / EMPLOYEE', '0',
      (select count(*)::text from public.profiles where role::text not in ('OWNER', 'DEV', 'EMPLOYEE'))),
  (9, 'at least one ACTIVE DEV (needed to set up the new accounts)', 'yes',
      case when exists (select 1 from public.profiles where role = 'DEV' and status = 'ACTIVE') then 'yes' else 'no' end)
) as t (check_no, check_name, expected, actual)
order by check_no;
