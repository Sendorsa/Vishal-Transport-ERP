-- Diesel database, phase 1 — design approved by the owner on 1 Nov 2026 (D-1 … D-18). See docs/SUPABASE_DIESEL_DATABASE_SCHEMA.md §8.
--
-- Row Level Security on every table; nothing for anon (signed-out visitors). Every policy goes through
-- private.can(...) / private.month_open(...), which return false for anyone without an ACTIVE ERP account, so a
-- Google account without an invitation sees nothing. Owner-only actions test the role by name (private.is_owner()).
-- service_role (server only, never the browser) bypasses RLS for administration.

/* ------------------------------------------------------------------ grants */

revoke all on schema core, fuel, finance, audit, private from public, anon;
grant usage on schema core, fuel, finance, audit, private to authenticated, service_role;

revoke all on all tables in schema core, fuel, finance, audit from public, anon, authenticated;
grant all on all tables in schema core, fuel, finance, audit to service_role;

revoke all on all functions in schema private from public, anon;
grant execute on all functions in schema private to authenticated, service_role;

-- Reads (RLS decides which rows).
grant select on all tables in schema core, fuel, finance, audit to authenticated;

-- Masters: insert and update only — never deleted (archive / restore).
grant insert, update on core.companies, core.vehicle_types, core.customers, core.customer_status_periods, core.drivers,
  core.vehicles, core.vehicle_status_periods, core.vehicle_assignments, core.month_locks, fuel.fuel_stations, fuel.tankers
  to authenticated;

-- Transactions.
grant insert, update, delete on fuel.diesel_entries, fuel.tanker_loads, fuel.adblue_purchases, fuel.adblue_entries, finance.payments to authenticated;
grant insert, delete on fuel.tanker_transfers, fuel.tanker_adjustments to authenticated; -- no edits: delete and re-enter

-- Audit: append only.
grant insert on audit.events, audit.reviews to authenticated;

/* ------------------------------------------------------------------ RLS on */

alter table core.role_permissions enable row level security;
alter table core.companies enable row level security;
alter table core.vehicle_types enable row level security;
alter table core.customers enable row level security;
alter table core.customer_status_periods enable row level security;
alter table core.drivers enable row level security;
alter table core.vehicles enable row level security;
alter table core.vehicle_status_periods enable row level security;
alter table core.vehicle_assignments enable row level security;
alter table core.month_locks enable row level security;
alter table fuel.fuel_stations enable row level security;
alter table fuel.tankers enable row level security;
alter table fuel.diesel_entries enable row level security;
alter table fuel.tanker_loads enable row level security;
alter table fuel.tanker_transfers enable row level security;
alter table fuel.tanker_adjustments enable row level security;
alter table fuel.adblue_purchases enable row level security;
alter table fuel.adblue_entries enable row level security;
alter table finance.payment_categories enable row level security;
alter table finance.payments enable row level security;
alter table audit.events enable row level security;
alter table audit.reviews enable row level security;

/* ------------------------------------------------------------------ configuration (any ERP role reads) */

create policy "ERP users read" on core.role_permissions for select to authenticated using ((select private.erp_role()) is not null);
create policy "ERP users read" on core.companies for select to authenticated using ((select private.erp_role()) is not null);
create policy "ERP users read" on core.vehicle_types for select to authenticated using ((select private.erp_role()) is not null);
create policy "ERP users read" on finance.payment_categories for select to authenticated using ((select private.erp_role()) is not null);
create policy "ERP users read" on core.month_locks for select to authenticated using ((select private.erp_role()) is not null);

create policy "Settings add companies" on core.companies for insert to authenticated with check ((select private.can('settings', 'edit')));
create policy "Settings edit companies" on core.companies for update to authenticated using ((select private.can('settings', 'edit')));
-- Vehicle types are also added inline from the vehicle forms (vehicles:edit).
create policy "Add vehicle types" on core.vehicle_types for insert to authenticated
  with check ((select private.can('settings', 'edit')) or (select private.can('vehicles', 'edit')));
create policy "Edit vehicle types" on core.vehicle_types for update to authenticated
  using ((select private.can('settings', 'edit')) or (select private.can('vehicles', 'edit')));

-- Month locks: Owner only (lock early / unlock for users).
create policy "Owner locks months" on core.month_locks for insert to authenticated with check ((select private.is_owner()) and changed_by_role = 'OWNER');
create policy "Owner unlocks months" on core.month_locks for update to authenticated using ((select private.is_owner())) with check (changed_by_role = 'OWNER');

/* ------------------------------------------------------------------ customers, drivers, vehicles */

-- The Diesel pages show customers and vehicles to every role with diesel:view (D-3).
create policy "Read customers" on core.customers for select to authenticated
  using ((select private.can('customers', 'view')) or (select private.can('diesel', 'view')) or (select private.can('trips', 'view')));
create policy "Add customers" on core.customers for insert to authenticated with check ((select private.can('customers', 'create')));
create policy "Edit customers" on core.customers for update to authenticated using ((select private.can('customers', 'edit')));

create policy "Read customer status" on core.customer_status_periods for select to authenticated
  using ((select private.can('customers', 'view')) or (select private.can('diesel', 'view')) or (select private.can('trips', 'view')));
create policy "Write customer status" on core.customer_status_periods for insert to authenticated
  with check ((select private.can('customers', 'create')) or (select private.can('customers', 'edit')));
create policy "Close customer status" on core.customer_status_periods for update to authenticated using ((select private.can('customers', 'edit')));

create policy "Read drivers" on core.drivers for select to authenticated
  using ((select private.can('vehicles', 'view')) or (select private.can('diesel', 'view')) or (select private.can('settings', 'view')) or (select private.can('trips', 'view')));
create policy "Add drivers" on core.drivers for insert to authenticated with check ((select private.can('settings', 'edit')) or (select private.can('vehicles', 'edit')));
create policy "Edit drivers" on core.drivers for update to authenticated using ((select private.can('settings', 'edit')) or (select private.can('vehicles', 'edit')));

create policy "Read vehicles" on core.vehicles for select to authenticated
  using ((select private.can('vehicles', 'view')) or (select private.can('diesel', 'view')) or (select private.can('trips', 'view')));
create policy "Add vehicles" on core.vehicles for insert to authenticated with check ((select private.can('vehicles', 'create')));
create policy "Edit vehicles" on core.vehicles for update to authenticated using ((select private.can('vehicles', 'edit')));

create policy "Read vehicle status" on core.vehicle_status_periods for select to authenticated
  using ((select private.can('vehicles', 'view')) or (select private.can('diesel', 'view')) or (select private.can('trips', 'view')));
create policy "Write vehicle status" on core.vehicle_status_periods for insert to authenticated
  with check ((select private.can('vehicles', 'create')) or (select private.can('vehicles', 'edit')));
create policy "Close vehicle status" on core.vehicle_status_periods for update to authenticated using ((select private.can('vehicles', 'edit')));

-- Assignments change only by transfer (vehicles:edit); a back-dated transfer follows the month lock of its effective date.
create policy "Read assignments" on core.vehicle_assignments for select to authenticated
  using ((select private.can('vehicles', 'view')) or (select private.can('diesel', 'view')) or (select private.can('trips', 'view')));
create policy "Start assignments" on core.vehicle_assignments for insert to authenticated
  with check (((select private.can('vehicles', 'create')) or (select private.can('vehicles', 'edit'))) and private.month_open(start_date));
create policy "End assignments" on core.vehicle_assignments for update to authenticated
  using ((select private.can('vehicles', 'edit')))
  with check (end_date is null or private.month_open(end_date + 1));

/* ------------------------------------------------------------------ fuel masters */

create policy "Read fuel stations" on fuel.fuel_stations for select to authenticated
  using ((select private.can('diesel', 'view')) or (select private.can('payments', 'view')));
create policy "Add fuel stations" on fuel.fuel_stations for insert to authenticated
  with check ((select private.can('diesel', 'create')) and not is_tanker_source and opening_balance is null);
create policy "Edit fuel stations" on fuel.fuel_stations for update to authenticated
  using ((select private.can('diesel', 'edit'))); -- opening balance (Owner / Dev, month lock): fuel_station_guard

create policy "Read tankers" on fuel.tankers for select to authenticated
  using ((select private.can('diesel', 'view')) or (select private.can('vehicles', 'view')));
create policy "Add tankers" on fuel.tankers for insert to authenticated with check ((select private.can('vehicles', 'edit')));
create policy "Edit tankers" on fuel.tankers for update to authenticated using ((select private.can('vehicles', 'edit')));

/* ------------------------------------------------------------------ fuel transactions (month lock: Owner always, others while open) */

create policy "Read diesel entries" on fuel.diesel_entries for select to authenticated using ((select private.can('diesel', 'view')));
create policy "Add diesel entries" on fuel.diesel_entries for insert to authenticated
  with check ((select private.can('diesel', 'create')) and private.month_open(date));
create policy "Edit diesel entries" on fuel.diesel_entries for update to authenticated
  using ((select private.can('diesel', 'edit')) and private.month_open(date)) with check (private.month_open(date));
create policy "Delete diesel entries" on fuel.diesel_entries for delete to authenticated
  using ((select private.can('diesel', 'delete')) and private.month_open(date));

create policy "Read tanker loads" on fuel.tanker_loads for select to authenticated using ((select private.can('diesel', 'view')));
-- Opening stock (fresh start) is Owner / Dev only (assertWorkspaceAdmin).
create policy "Add tanker loads" on fuel.tanker_loads for insert to authenticated
  with check (private.month_open(date) and case when opening then (select private.is_owner_or_dev()) else (select private.can('diesel', 'create')) end);
create policy "Edit tanker loads" on fuel.tanker_loads for update to authenticated
  using ((select private.can('diesel', 'edit')) and private.month_open(date) and not opening) with check (private.month_open(date) and not opening);
create policy "Delete tanker loads" on fuel.tanker_loads for delete to authenticated
  using ((select private.can('diesel', 'delete')) and private.month_open(date));

create policy "Read tanker transfers" on fuel.tanker_transfers for select to authenticated using ((select private.can('diesel', 'view')));
create policy "Add tanker transfers" on fuel.tanker_transfers for insert to authenticated
  with check ((select private.can('diesel', 'create')) and private.month_open(date));
create policy "Delete tanker transfers" on fuel.tanker_transfers for delete to authenticated
  using ((select private.can('diesel', 'delete')) and private.month_open(date));

create policy "Read tanker adjustments" on fuel.tanker_adjustments for select to authenticated using ((select private.can('diesel', 'view')));
create policy "Add tanker adjustments" on fuel.tanker_adjustments for insert to authenticated
  with check ((select private.can('diesel', 'edit')) and private.month_open(date));
create policy "Delete tanker adjustments" on fuel.tanker_adjustments for delete to authenticated
  using ((select private.can('diesel', 'delete')) and private.month_open(date));

create policy "Read AdBlue purchases" on fuel.adblue_purchases for select to authenticated using ((select private.can('diesel', 'view')));
create policy "Add AdBlue purchases" on fuel.adblue_purchases for insert to authenticated
  with check ((select private.can('diesel', 'create')) and private.month_open(date));
create policy "Edit AdBlue purchases" on fuel.adblue_purchases for update to authenticated
  using ((select private.can('diesel', 'edit')) and private.month_open(date)) with check (private.month_open(date));
create policy "Delete AdBlue purchases" on fuel.adblue_purchases for delete to authenticated
  using ((select private.can('diesel', 'delete')) and private.month_open(date));

create policy "Read AdBlue entries" on fuel.adblue_entries for select to authenticated using ((select private.can('diesel', 'view')));
create policy "Add AdBlue entries" on fuel.adblue_entries for insert to authenticated
  with check ((select private.can('diesel', 'create')) and private.month_open(date));
create policy "Edit AdBlue entries" on fuel.adblue_entries for update to authenticated
  using ((select private.can('diesel', 'edit')) and private.month_open(date)) with check (private.month_open(date));
create policy "Delete AdBlue entries" on fuel.adblue_entries for delete to authenticated
  using ((select private.can('diesel', 'delete')) and private.month_open(date));

/* ------------------------------------------------------------------ fuel station payments */

-- The Fuel Stations ledger shows station payments to every role with diesel:view (D-3); only payments:* may change them.
create policy "Read payments" on finance.payments for select to authenticated
  using ((select private.can('payments', 'view')) or (select private.can('diesel', 'view')));
create policy "Record payments" on finance.payments for insert to authenticated
  with check ((select private.can('payments', 'create')) and private.month_open(date));
create policy "Edit payments" on finance.payments for update to authenticated
  using ((select private.can('payments', 'edit')) and private.month_open(date)) with check (private.month_open(date));
create policy "Delete payments" on finance.payments for delete to authenticated
  using ((select private.can('payments', 'delete')) and private.month_open(date));

/* ------------------------------------------------------------------ audit */

-- Owner and Dev read the whole log; other roles read the history of modules they can view (record History button).
create policy "Read audit events" on audit.events for select to authenticated
  using ((select private.can('audit', 'view')) or private.can(private.module_resource(module), 'view'));
-- Events are written as the signed-in user and role. Restores and month locks: Owner only. Data resets: never
-- from a session (D-9). SYSTEM events come only from service_role / migrations.
create policy "Write own audit events" on audit.events for insert to authenticated
  with check (
    actor_kind = 'SESSION'
    and actor_user_id = (select private.current_profile_id())
    and actor_role = (select private.erp_role())
    and action <> 'DATA_RESET'
    and (action <> 'DELETED' or private.can(private.module_resource(module), 'delete')) -- no deletion events without the right to delete
    and (restores_event_id is null or (select private.is_owner()))
    and (action not in ('MONTH_LOCKED', 'MONTH_UNLOCKED') or (select private.is_owner()))
  );

create policy "Owner and Dev read reviews" on audit.reviews for select to authenticated using ((select private.can('audit', 'view')));
create policy "Owner reviews deletions" on audit.reviews for insert to authenticated
  with check ((select private.is_owner()) and actor_user_id = (select private.current_profile_id()) and actor_role = 'OWNER');
