-- Pre-flight for the Industrial Diesel migrations: is Production ready for 20261112000000_industrial_diesel_supply.sql
-- and 20261112000100_industrial_tanker_allocations.sql? Run BEFORE the first one (and again just before the second
-- if anything happened in between: then rows 20–25 show the first migration's own objects, which is expected).
-- READ-ONLY: a single SELECT over the system catalogs, core.role_permissions, public.profiles and the tanker tables
-- (row counts and the existing stock check only). It writes nothing, creates nothing, locks nothing beyond a normal
-- read and changes no permission. Run it in the Supabase SQL Editor of project dqnoducqiootfvkzskhu (check the URL).
-- Generated 2026-11-12T07:37:17.875Z from the repository's migrations through 20261111000200 (migration B) applied to an
-- in-memory PostgreSQL; object fingerprints use the catalog query of 08-industrial-post-apply-fingerprint.sql.
--
-- Output: check_no | check_name | expected | actual | status.
--   OK   = as required.
--   INFO = rows 3 and 30–31: facts to note, never a reason to stop on their own (see each row).
--   STOP = do not apply either migration:
--     1        not the postgres database                              → wrong database / project
--     2        migration B (AdBlue profiles) missing                  → apply / check B first (it adds customer_in_scope)
--     4        a required schema or table is missing
--     5        the diesel permission rows differ                      → core.role_permissions differs from the repository
--     6        the server login role erp_server is missing or changed
--     20–25    a name the migrations will create already exists       → a migration was applied (fully or partly) or a
--                                                                         conflicting object exists: inspect it first
--     100+     an existing object the migrations rely on differs: the tanker stock view (fuel.tanker_movements — the
--              migration REPLACES it, so it must be exactly the repository's), the stock functions and triggers, the
--              helper functions, the tanker tables, their policies, the schemas' grants
with actual as (
select kind, name, md5(fp) as fp, fp as detail from (
  -- schemas and their grants
  select 'schema' as kind, n.nspname::text as name,
         coalesce((select string_agg(g, ',' order by g collate "C") from (select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end || ':' || a.privilege_type as g from aclexplode(n.nspacl) a) acl), '-') as fp
  from pg_namespace n where n.nspname in ('core', 'fuel', 'finance', 'audit', 'ops', 'billing', 'private', 'public') and n.nspname <> 'public'
  union all
  -- functions: exact source text, security, settings, volatility, result type
  select 'function', p.oid::regprocedure::text,
         p.prokind::text || '|' || p.prosecdef || '|' || p.provolatile::text || '|' || coalesce(array_to_string(p.proconfig, ','), '') || '|' || pg_get_function_result(p.oid) || '|' || p.prosrc
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('core', 'fuel', 'finance', 'audit', 'ops', 'billing', 'private', 'public') and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  union all
  select 'function grants', p.oid::regprocedure::text,
         coalesce((select string_agg(g, ',' order by g collate "C") from (select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end || ':' || a.privilege_type as g from aclexplode(p.proacl) a) acl), 'default')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('core', 'fuel', 'finance', 'audit', 'ops', 'billing', 'private', 'public') and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  union all
  -- tables and views: kind, RLS flags, every column (type, nullability, default, generated expression)
  select case c.relkind when 'v' then 'view' else 'table' end, n.nspname || '.' || c.relname,
         c.relkind::text || '|rls=' || c.relrowsecurity || '|force=' || c.relforcerowsecurity || '|' ||
         coalesce((select string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || case when a.attnotnull then ' not null' else '' end
                    || coalesce(' default ' || pg_get_expr(d.adbin, d.adrelid), '') || case when a.attgenerated <> '' then ' generated' else '' end, ', ' order by a.attname)
                   from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
                   where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped), '')
         || case when c.relkind = 'v' then '|' || pg_get_viewdef(c.oid) else '' end
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('core', 'fuel', 'finance', 'audit', 'ops', 'billing', 'private', 'public') and c.relkind in ('r', 'v', 'p') and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')
  union all
  select 'table grants', n.nspname || '.' || c.relname,
         coalesce((select string_agg(g, ',' order by g collate "C") from (select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end || ':' || a.privilege_type as g from aclexplode(c.relacl) a) acl), 'default')
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('core', 'fuel', 'finance', 'audit', 'ops', 'billing', 'private', 'public') and c.relkind in ('r', 'v', 'p') and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')
  union all
  -- constraints (NOT NULL entries excluded: PostgreSQL 18 lists them here, 17 doesn't — nullability is in the table row)
  select 'constraint', n.nspname || '.' || c.relname || '.' || k.conname, k.contype::text || '|' || pg_get_constraintdef(k.oid)
  from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('core', 'fuel', 'finance', 'audit', 'ops', 'billing', 'private', 'public') and k.contype <> 'n'
  union all
  select 'index', n.nspname || '.' || i.relname, pg_get_indexdef(i.oid)
  from pg_index x join pg_class i on i.oid = x.indexrelid join pg_namespace n on n.oid = i.relnamespace
  where n.nspname in ('core', 'fuel', 'finance', 'audit', 'ops', 'billing', 'private', 'public')
  union all
  -- triggers on our tables, and our triggers on auth tables
  select 'trigger', t.tgrelid::regclass::text || '.' || t.tgname, pg_get_triggerdef(t.oid) || '|enabled=' || t.tgenabled::text
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
  join pg_proc p on p.oid = t.tgfoid join pg_namespace pn on pn.oid = p.pronamespace
  where not t.tgisinternal and (n.nspname in ('core', 'fuel', 'finance', 'audit', 'ops', 'billing', 'private', 'public') or pn.nspname in ('private'))
  union all
  -- RLS policies (command, permissive, roles, USING, WITH CHECK)
  select 'policy', n.nspname || '.' || c.relname || '.' || p.polname,
         p.polcmd::text || '|' || p.polpermissive || '|' || (p.polroles::regrole[])::text || '|' || coalesce(pg_get_expr(p.polqual, p.polrelid), '') || '|' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
  from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('core', 'fuel', 'finance', 'audit', 'ops', 'billing', 'private', 'public')
  union all
  -- enum types (values in order)
  select 'enum', n.nspname || '.' || t.typname, string_agg(e.enumlabel, ',' order by e.enumsortorder)
  from pg_type t join pg_namespace n on n.oid = t.typnamespace join pg_enum e on e.enumtypid = t.oid
  where n.nspname in ('core', 'fuel', 'finance', 'audit', 'ops', 'billing', 'private', 'public') group by n.nspname, t.typname
  union all
  -- the server login role (20261103000100): login, NOINHERIT, member of authenticated (never the password)
  select 'role', r.rolname, 'login=' || r.rolcanlogin || '|inherit=' || r.rolinherit || '|member_of=' ||
         coalesce((select string_agg(g.rolname, ',' order by g.rolname) from pg_auth_members m join pg_roles g on g.oid = m.roleid where m.member = r.oid), '-')
  from pg_roles r where r.rolname = 'erp_server'
  union all
  -- permission rows (core.role_permissions)
  select 'permission row', rp.role::text || ' ' || rp.permission, '1' from core.role_permissions rp
  union all
  -- reference rows the migrations seed (existence by code only; content may be edited in Settings)
  select 'reference row', 'core.vehicle_types ' || code, '1' from core.vehicle_types
  where code in ('BUS_55', 'BUS_41', 'BUS_32', 'MINI_24', 'TT_17', 'SUV', 'SEDAN', 'TRUCK_19', 'PICKUP')
  union all
  select 'reference row', 'finance.payment_categories ' || code, '1' from finance.payment_categories
  where code in ('DIESEL_SETTLEMENT', 'DRIVER_SALARY', 'STAFF_SALARY', 'EMI', 'TYRE', 'MAINTENANCE', 'INSURANCE', 'ROAD_TAX', 'ATTACH_VEHICLE', 'TOLL', 'RENT', 'OFFICE', 'OTHER', 'GST_PAYMENT')
  union all
  select 'reference row', 'core.app_settings id 1', '1'
  where case when to_regclass('core.app_settings') is null then false
             else (xpath('/row/n/text()', query_to_xml('select count(*) as n from core.app_settings where id = 1', false, true, '')))[1]::text::int > 0 end
  union all
  select 'reference row', 'fuel.fuel_stations dv_tanker', '1' from fuel.fuel_stations where id = 'dv_tanker'
) f
),
expected_objects (kind, name, fp) as (
  values
    ('function', 'private.assert_not_archived_on(text,text,date)', '62703fb29abf42d505425fc92560fc0f'),
    ('function', 'private.can(text,text)', '99bd449d4fa5e12fce30019460e22155'),
    ('function', 'private.current_profile_id()', '41bc8c712abec0e1bda71a7e3724911a'),
    ('function', 'private.customer_in_scope(text)', '5ebdaeb707976ad4038393c0a23e28f6'),
    ('function', 'private.erp_role()', '418f52db1b7ec784d65d957d0ae25f57'),
    ('function', 'private.month_open(date)', 'e5d112b00f55c5f0f11d0c5ecf0e2661'),
    ('function', 'private.new_id(text)', '6978c0dfec3ff41425341d68c49e31e3'),
    ('function', 'private.refuse_future_date()', '206b6a38392258c36fcd5f73e8bd20de'),
    ('function', 'private.require_audit_event()', '3c558310d7f112e5bfe5af8448a618f1'),
    ('function', 'private.require_parent_audit_event()', '89ea3ec6305b8ff2b278db278f367d75'),
    ('function', 'private.tanker_ids_of(jsonb,jsonb)', 'a3826fb29e16f027db2ac59962dc1fdf'),
    ('function', 'private.tanker_shortfall(text)', '5054d863c5d9a7a293b16db3834497e0'),
    ('function', 'private.tanker_stock_check()', 'dfff3dfdceb84e94f74228288961c8a6'),
    ('function', 'private.tanker_stock_lock()', 'e28f17efb8566f79346306b263064adc'),
    ('function', 'private.touch_updated_at()', 'a833552ffc9fc15c27b1c0142b93d869'),
    ('function grants', 'private.assert_not_archived_on(text,text,date)', 'f440cb7547aafb71bac3b9275ad5f4bd'),
    ('function grants', 'private.can(text,text)', 'f440cb7547aafb71bac3b9275ad5f4bd'),
    ('function grants', 'private.current_profile_id()', 'f440cb7547aafb71bac3b9275ad5f4bd'),
    ('function grants', 'private.customer_in_scope(text)', 'f440cb7547aafb71bac3b9275ad5f4bd'),
    ('function grants', 'private.erp_role()', 'f440cb7547aafb71bac3b9275ad5f4bd'),
    ('function grants', 'private.month_open(date)', 'f440cb7547aafb71bac3b9275ad5f4bd'),
    ('function grants', 'private.new_id(text)', 'f440cb7547aafb71bac3b9275ad5f4bd'),
    ('function grants', 'private.refuse_future_date()', 'f440cb7547aafb71bac3b9275ad5f4bd'),
    ('function grants', 'private.require_audit_event()', 'f440cb7547aafb71bac3b9275ad5f4bd'),
    ('function grants', 'private.require_parent_audit_event()', '21204a2977c7fe81491fdd923df9ce35'),
    ('function grants', 'private.tanker_ids_of(jsonb,jsonb)', 'f440cb7547aafb71bac3b9275ad5f4bd'),
    ('function grants', 'private.tanker_shortfall(text)', 'f440cb7547aafb71bac3b9275ad5f4bd'),
    ('function grants', 'private.tanker_stock_check()', 'f440cb7547aafb71bac3b9275ad5f4bd'),
    ('function grants', 'private.tanker_stock_lock()', 'f440cb7547aafb71bac3b9275ad5f4bd'),
    ('function grants', 'private.touch_updated_at()', 'f440cb7547aafb71bac3b9275ad5f4bd'),
    ('policy', 'fuel.diesel_entries.Add diesel entries', 'ba3b95cd5d469de8416d7dbaf162475a'),
    ('policy', 'fuel.diesel_entries.Delete diesel entries', '15202137cdec5cdfd92ec9e811d169f0'),
    ('policy', 'fuel.diesel_entries.Edit diesel entries', '0099bdcc804ae3dab3bc29b98160dd02'),
    ('policy', 'fuel.diesel_entries.Read diesel entries', '4ba2a9ff19e8bcb12e16b65b00844570'),
    ('policy', 'fuel.tanker_adjustments.Add tanker adjustments', '7d189724c59e356455ce1f3e746405ee'),
    ('policy', 'fuel.tanker_adjustments.Delete tanker adjustments', '15202137cdec5cdfd92ec9e811d169f0'),
    ('policy', 'fuel.tanker_adjustments.Read tanker adjustments', '4ba2a9ff19e8bcb12e16b65b00844570'),
    ('policy', 'fuel.tanker_loads.Add tanker loads', '1302babd4a021926923b05d908b644e4'),
    ('policy', 'fuel.tanker_loads.Delete tanker loads', '15202137cdec5cdfd92ec9e811d169f0'),
    ('policy', 'fuel.tanker_loads.Edit tanker loads', 'b5b36cdf262586ff327340a5716270b7'),
    ('policy', 'fuel.tanker_loads.Read tanker loads', '4ba2a9ff19e8bcb12e16b65b00844570'),
    ('policy', 'fuel.tanker_transfers.Add tanker transfers', 'ba3b95cd5d469de8416d7dbaf162475a'),
    ('policy', 'fuel.tanker_transfers.Delete tanker transfers', '15202137cdec5cdfd92ec9e811d169f0'),
    ('policy', 'fuel.tanker_transfers.Read tanker transfers', '4ba2a9ff19e8bcb12e16b65b00844570'),
    ('policy', 'fuel.tankers.Add tankers', 'f5f170a16d6e1cee32e28941c7c3daaa'),
    ('policy', 'fuel.tankers.Edit tankers', '788160ef256e86319bf51e139a6a7d08'),
    ('policy', 'fuel.tankers.Read tankers', '6cc1e2dd011c4184cc00bac4f00f01b0'),
    ('schema', 'fuel', '9ccd6daa6db14a0b3dc07c2edda0b13f'),
    ('schema', 'private', '9ccd6daa6db14a0b3dc07c2edda0b13f'),
    ('table', 'audit.events', 'cfd4883c9ee6bebbf9f36c3b30b8f0bd'),
    ('table', 'core.customers', '8a42b94f470f7c1c6a1b9c8ed5697ca3'),
    ('table', 'core.profile_customer_access', 'e92d961ad430a852984a2fdce79703d6'),
    ('table', 'fuel.diesel_entries', '380ecdc5050ae78b9f35d9d59a222469'),
    ('table', 'fuel.tanker_adjustments', 'f76e0712ec5bf750023c978309e0458e'),
    ('table', 'fuel.tanker_loads', 'f6424e54a45061eba7e33654fe352a30'),
    ('table', 'fuel.tanker_transfers', '371aafe7b509160f4a37ccd1c8ca2042'),
    ('table', 'fuel.tankers', '50fcec7d6d948f185172c4bf69154683'),
    ('table', 'public.profiles', '6dc0e479657c2c37d21efc4bb16ceffb'),
    ('table grants', 'audit.events', '8a5a04d0ce457417d1de07363ac226a2'),
    ('table grants', 'core.customers', 'ec2e1b090bafd56e7e80481d1255dcac'),
    ('table grants', 'core.profile_customer_access', 'd2b6dc12775f6a41336910ecb0bae1f0'),
    ('table grants', 'fuel.diesel_entries', '6f423376fe7f1644ff9c0a0b97435967'),
    ('table grants', 'fuel.tanker_adjustments', '292b5ae69fee68a8a5e3c402bc8cb2bc'),
    ('table grants', 'fuel.tanker_loads', '6f423376fe7f1644ff9c0a0b97435967'),
    ('table grants', 'fuel.tanker_transfers', '292b5ae69fee68a8a5e3c402bc8cb2bc'),
    ('table grants', 'fuel.tankers', 'ec2e1b090bafd56e7e80481d1255dcac'),
    ('table grants', 'public.profiles', 'd2b6dc12775f6a41336910ecb0bae1f0'),
    ('trigger', 'fuel.diesel_entries.diesel_entries_bump_odometer', 'a0aa04ac765bea6a3d999bc4dd32ef72'),
    ('trigger', 'fuel.diesel_entries.diesel_entries_check_stock', '6905d5c530f83c678402b0e163381233'),
    ('trigger', 'fuel.diesel_entries.diesel_entries_no_future', '930f2359285d98ead5d859042117ac8b'),
    ('trigger', 'fuel.diesel_entries.diesel_entries_open_guard', '8e0fd58a825330c0ca7d0246ee15f8fe'),
    ('trigger', 'fuel.diesel_entries.diesel_entries_require_audit', '0b802f7512ff6c985fc9bc06ab0b7309'),
    ('trigger', 'fuel.diesel_entries.diesel_entries_stock_lock', 'df51e5af22aaf0b343a30f9917f5b76e'),
    ('trigger', 'fuel.diesel_entries.diesel_entries_touch', '2451214d29a49463f91d23e890e15cd6'),
    ('trigger', 'fuel.tanker_adjustments.tanker_adjustments_check_stock', 'afc3c823dacbd2cbed47960077244e66'),
    ('trigger', 'fuel.tanker_adjustments.tanker_adjustments_no_future', '9d9bbb2295a00012ed74743fc5bcec55'),
    ('trigger', 'fuel.tanker_adjustments.tanker_adjustments_require_audit', '5f129a900293a07c60223c4b751e0441'),
    ('trigger', 'fuel.tanker_adjustments.tanker_adjustments_stock_lock', 'd1a5c5e8c7ef3436a4d72132e75996ad'),
    ('trigger', 'fuel.tanker_adjustments.tanker_adjustments_touch', 'caade1caa6e8a3396017feb1134bf581'),
    ('trigger', 'fuel.tanker_loads.tanker_loads_check_stock', '5f2eab94d8aecdaa3ad623387bf8aab0'),
    ('trigger', 'fuel.tanker_loads.tanker_loads_guard', '9e8f858894731268488874fd504c3569'),
    ('trigger', 'fuel.tanker_loads.tanker_loads_no_future', 'b7ac8789622f564656c41ca298308597'),
    ('trigger', 'fuel.tanker_loads.tanker_loads_require_audit', '7b7258bc77e7ef0328cb74aa43903e1a'),
    ('trigger', 'fuel.tanker_loads.tanker_loads_stock_lock', '94583cd84836ef899cfcb23e2e757447'),
    ('trigger', 'fuel.tanker_loads.tanker_loads_touch', '13519df4e3481311c0baeade6ba57c25'),
    ('trigger', 'fuel.tanker_transfers.tanker_transfers_check_stock', 'a1d7ab1367d4cb6d65631535a35bb3b5'),
    ('trigger', 'fuel.tanker_transfers.tanker_transfers_no_future', 'b0c978a12153a5b60d32a8f577c9e737'),
    ('trigger', 'fuel.tanker_transfers.tanker_transfers_require_audit', '3c1d402f61203d8234293e03afb74191'),
    ('trigger', 'fuel.tanker_transfers.tanker_transfers_stock_lock', 'f6b76682bc62b2bac1038e24d76e3e19'),
    ('trigger', 'fuel.tanker_transfers.tanker_transfers_touch', 'd243ed7e4cfed26e4d305dc196d4f483'),
    ('trigger', 'fuel.tankers.tankers_require_audit', '790c3caca8e6326fc68dd594f44dd1eb'),
    ('trigger', 'fuel.tankers.tankers_touch', '3fe9523298a4b2b1db858866598a7cc8'),
    ('view', 'fuel.tanker_movements', '56e1a1693f5e5e63861792737ce66393')
),
checks (check_no, check_name, expected, actual) as (
  values
    (1, 'database', 'postgres', current_database()::text), -- ::text: a 'name' here would type the column and cut longer values to 63 bytes
    (2, 'migration B present (customer_in_scope, profile_customer_access, the two AdBlue roles)', 'yes',
        case when to_regprocedure('private.customer_in_scope(text)') is not null and to_regclass('core.profile_customer_access') is not null
              and (select count(*) from pg_enum e where e.enumtypid = to_regtype('public.erp_role') and e.enumlabel in ('TATA_ADBLUE', 'ADBLUE')) = 2 then 'yes' else 'no' end),
    (3, 'month-lock migration 20261111000000 (INFO: either is fine; tells how to read 08)', 'applied or not applied',
        case when to_regprocedure('private.can_set_month_lock()') is null then 'not applied' else 'applied' end),
    (4, 'schemas core, fuel, audit, private; tables customers, profiles, tankers, tanker_loads, diesel_entries, tanker_transfers, tanker_adjustments, audit.events', '12',
        ((select count(*) from pg_namespace where nspname in ('core', 'fuel', 'audit', 'private'))
         + (select count(*) from unnest(array['core.customers', 'public.profiles', 'fuel.tankers', 'fuel.tanker_loads', 'fuel.diesel_entries', 'fuel.tanker_transfers', 'fuel.tanker_adjustments', 'audit.events']) t where to_regclass(t) is not null))::text),
    (5, 'diesel permission rows (core.role_permissions)', 'ADBLUE:diesel:view,EMPLOYEE:diesel:*,EMPLOYEE:diesel:create,EMPLOYEE:diesel:edit,EMPLOYEE:diesel:view,OWNER:diesel:*,TATA_ADBLUE:diesel:view',
        (select string_agg(role::text || ':' || permission, ',' order by role::text collate "C", permission collate "C") from core.role_permissions where permission like 'diesel%')),
    (6, 'server login role erp_server (login, noinherit)', 'login=true|inherit=false',
        (select 'login=' || rolcanlogin || '|inherit=' || rolinherit from pg_roles where rolname = 'erp_server')),
    (20, 'no existing table / type named fuel.industrial%', '0', (select count(*)::text from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'fuel' and c.relname like 'industrial%')),
    (21, 'no existing type named fuel.industrial%', '0', (select count(*)::text from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'fuel' and t.typname like 'industrial%')),
    (22, 'no existing function named private.industrial%', '0', (select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname like 'industrial%')),
    (23, 'no existing trigger named *industrial*', '0', (select count(*)::text from pg_trigger where tgname like 'industrial%')),
    (24, 'no existing policy named *industrial*', '0', (select count(*)::text from pg_policy where polname ilike '%industrial%')),
    (25, 'no existing constraint named *industrial*', '0', (select count(*)::text from pg_constraint where conname like 'industrial%')),
    (30, 'tankers / their stock movements today (INFO: what the migration''s view replacement covers)', 'any',
        (select count(*) from fuel.tankers)::text || ' tankers · ' || (select count(*) from fuel.tanker_movements)::text || ' movements'),
    (31, 'tankers whose records already go below zero (INFO: an industrial supply from one is refused until corrected)', '0',
        (select count(*) from fuel.tankers t where exists (select 1 from private.tanker_shortfall(t.id)))::text)
)
select check_no, check_name, expected, actual,
       case when check_no in (3, 30) then 'INFO' when check_no = 31 then case when actual = expected then 'OK' else 'INFO' end
            when actual = expected then 'OK' else 'STOP' end as status
from (
  select check_no, check_name, expected, actual from checks
  union all
  select (100 + row_number() over (order by e.kind collate "C", e.name collate "C"))::int, e.kind || ' ' || e.name, e.fp, coalesce(a.fp, 'missing')
  from expected_objects e left join actual a on a.kind = e.kind and a.name = e.name
) t
order by check_no;
