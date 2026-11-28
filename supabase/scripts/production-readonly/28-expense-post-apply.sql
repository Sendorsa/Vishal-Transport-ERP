-- READ-ONLY. Run after 20261128000000_expense_schema.sql. Every CHECK row must say OK. A single SELECT — it changes nothing.
select check_no, check_name, expected, actual,
       case when kind = 'INFO' then 'INFO' when actual = expected then 'OK' else 'STOP' end as status
from (values
  (1, 'CHECK', 'six Expense tables', 'brokers, entries, entry_vehicles, import_batches, import_items, month_locks',
      (select string_agg(table_name, ', ' order by table_name) from information_schema.tables where table_schema = 'expense' and table_type = 'BASE TABLE')),
  (2, 'CHECK', 'all six empty (no backfill)', '0',
      ((select count(*) from expense.entries) + (select count(*) from expense.entry_vehicles) + (select count(*) from expense.brokers)
       + (select count(*) from expense.month_locks) + (select count(*) from expense.import_batches) + (select count(*) from expense.import_items))::text),
  (3, 'CHECK', 'RLS on every Expense table', 'on,on,on,on,on,on',
      (select string_agg(case when c.relrowsecurity then 'on' else 'OFF' end, ',' order by c.relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'expense' and c.relkind = 'r')),
  (4, 'CHECK', 'policies (table: command policy)',
      'brokers: INSERT Add brokers; brokers: SELECT Read brokers; entries: DELETE Delete Expense entries; entries: INSERT Add Expense entries; entries: SELECT Read Expense entries; entries: UPDATE Edit Expense entries; entry_vehicles: DELETE Remove Expense entry vehicles; entry_vehicles: INSERT Add Expense entry vehicles; entry_vehicles: SELECT Read Expense entry vehicles; import_batches: INSERT Record import batches; import_batches: SELECT Read import batches; import_items: INSERT Record import items; import_items: SELECT Read import items; month_locks: INSERT Lock Expense months; month_locks: SELECT Read Expense month locks',
      (select string_agg(tablename || ': ' || cmd || ' ' || policyname, '; ' order by tablename, cmd, policyname) from pg_policies where schemaname = 'expense')),
  (5, 'CHECK', 'grants to authenticated (no UPDATE / DELETE on brokers, month_locks, import_*)',
      'brokers: INSERT,SELECT; entries: DELETE,INSERT,SELECT,UPDATE; entry_vehicles: DELETE,INSERT,SELECT; import_batches: INSERT,SELECT; import_items: INSERT,SELECT; month_locks: INSERT,SELECT',
      (select string_agg(table_name || ': ' || p, '; ' order by table_name) from (select table_name, string_agg(privilege_type, ',' order by privilege_type) p from information_schema.role_table_grants where grantee = 'authenticated' and table_schema = 'expense' group by table_name) g)),
  (6, 'CHECK', 'no unlock path: no function body writes or deletes expense.month_locks', '0',
      (select count(*)::text from pg_proc where prosrc ~* '(update|delete\s+from)\s+expense\.month_locks')),
  (7, 'CHECK', 'no function body inserts, updates or deletes expense.* (guards only read)', '0',
      (select count(*)::text from pg_proc where prosrc ~* '(insert\s+into|update|delete\s+from)\s+expense\.')),
  (8, 'CHECK', 'functions mentioning expense. (the planned set)',
      'broker_ledger_guard, broker_opening_first, entry_vehicle_count, entry_vehicle_delete_guard, expense_broker_link, expense_month_lock_guard, expense_month_open',
      (select string_agg(proname, ', ' order by proname) from pg_proc where pronamespace = 'private'::regnamespace and prosrc ~ 'expense\.')),
  (9, 'CHECK', 'triggers on entries', 'entries_broker_ledger, entries_broker_link, entries_fixed, entries_month_lock, entries_not_future, entries_opening_first, entries_require_audit, entries_touch, entries_vehicle_count',
      (select string_agg(tgname, ', ' order by tgname) from pg_trigger where tgrelid = 'expense.entries'::regclass and not tgisinternal)),
  (10, 'CHECK', 'triggers on entry_vehicles', 'entry_vehicles_edit_delete, entry_vehicles_month_lock, entry_vehicles_require_audit, entry_vehicles_vehicle_count',
      (select string_agg(tgname, ', ' order by tgname) from pg_trigger where tgrelid = 'expense.entry_vehicles'::regclass and not tgisinternal)),
  (11, 'CHECK', 'unique / partial indexes', 'brokers_name_key, entries_bill_no_key, entries_one_opening, entries_request_id_key',
      (select string_agg(indexname, ', ' order by indexname) from pg_indexes where schemaname = 'expense' and indexname in ('brokers_name_key', 'entries_bill_no_key', 'entries_one_opening', 'entries_request_id_key'))),
  (12, 'CHECK', 'module_resource: Expense · Drivers', 'expenses · settings', private.module_resource('Expense') || ' · ' || private.module_resource('Drivers')),
  (13, 'CHECK', 'audit read policy filters Expense', 'yes',
      (select case when qual ~ 'Expense' and qual ~ 'expenses' then 'yes' else 'no' end from pg_policies where schemaname = 'audit' and tablename = 'events' and policyname = 'Read audit events')),
  (14, 'CHECK', 'reviews read / insert require a visible event', 'yes,yes',
      (select string_agg(case when coalesce(qual, with_check) ~ 'audit\.events' then 'yes' else 'no' end, ',' order by cmd) from pg_policies where schemaname = 'audit' and tablename = 'reviews' and policyname in ('Owner and Dev read reviews', 'Owner and Dev review deletions'))),
  (15, 'CHECK', 'changed_modules filters Expense', 'yes',
      (select case when prosrc ~ 'Expense' then 'yes' else 'no' end from pg_proc where oid = to_regprocedure('private.changed_modules(timestamptz)'))),
  (16, 'CHECK', 'expenses permission rows: none, or only EMP1 view / edit (20261129000100) and OWNER * (20261129000200)', 'none',
      coalesce((select string_agg(role::text || ' ' || permission, ', ' order by role::text, permission) from core.role_permissions
                where permission like 'expenses%' and not (role::text = 'EMP1' and permission in ('expenses:view', 'expenses:edit'))
                  and not (role::text = 'OWNER' and permission = 'expenses:*')), 'none')),
  (17, 'INFO', 'vehicles · customers · drivers · audit events (unchanged vs 27)', '',
      (select count(*)::text from core.vehicles) || ' · ' || (select count(*)::text from core.customers) || ' · ' || (select count(*)::text from core.drivers) || ' · ' || (select count(*)::text from audit.events))
) as t(check_no, kind, check_name, expected, actual)
order by check_no;
