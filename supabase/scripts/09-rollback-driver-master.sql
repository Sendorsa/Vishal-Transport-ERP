-- DESTRUCTIVE — ROLLBACK of 20261127000000_driver_master_company_periods.sql (Operations → Drivers). NOT read-only.
-- Prepared for review — run only on the owner's decision, in the Supabase Dashboard → SQL Editor (role postgres), as one
-- script.
--
-- Only while the migration's additions hold NO data: it stops (and changes nothing) if
--   * core.vehicle_company_periods has any row (a vehicle's dated company history), or
--   * any driver has a father's name, a date of birth or an address recorded, or
--   * any driver has no company_code (saved by the new app — company_code can't be made NOT NULL again).
-- It never fills in, changes or deletes a row: no backfill. If it stops, a rollback needs the owner's decision on that
-- data and a backup first (02-backup-business-data.sql); this script must not be edited to skip the checks.
--
-- What it does, in one transaction (all or nothing) — the statements of the migration's header:
--   1. drops core.vehicle_company_periods (with its triggers, policies, grants and indexes) and
--      private.vehicle_company_period_delete_guard();
--   2. drops core.drivers.father_name, date_of_birth and address; company_code NOT NULL again, without its column comment
--      (it had none before);
--   3. checks the result: the table, the function and the three columns are gone, company_code is NOT NULL, and
--      24-driver-master-preflight.sql's "not yet applied" check would say so again.
-- No audit event is written or removed (no row changes).
--
-- ORDER: deploy the app version WITHOUT the Drivers page / dated vehicle company first (it reads the new columns and
-- table). The Expense migration (20261128000000) doesn't use anything this removes; the previous app doesn't use the
-- shared Expense tables either. Afterwards 24-driver-master-preflight.sql reports every CHECK row OK again.

begin;

do $$
begin
  if to_regclass('core.vehicle_company_periods') is null or to_regprocedure('private.vehicle_company_period_delete_guard()') is null
     or (select count(*) from information_schema.columns where table_schema = 'core' and table_name = 'drivers' and column_name in ('father_name', 'date_of_birth', 'address')) <> 3 then
    raise exception 'Driver rollback stopped: 20261127000000 is not (fully) applied — nothing to roll back here. Nothing was changed.';
  end if;
  if exists (select 1 from core.vehicle_company_periods) then
    raise exception 'Driver rollback stopped: core.vehicle_company_periods holds % row(s) — vehicles'' dated company history would be lost. Nothing was changed.',
      (select count(*) from core.vehicle_company_periods);
  end if;
  if exists (select 1 from core.drivers where father_name <> '' or date_of_birth is not null or address <> '') then
    raise exception 'Driver rollback stopped: % driver(s) have a father''s name, date of birth or address recorded — it would be lost. Nothing was changed.',
      (select count(*) from core.drivers where father_name <> '' or date_of_birth is not null or address <> '');
  end if;
  if exists (select 1 from core.drivers where company_code is null) then
    raise exception 'Driver rollback stopped: % driver(s) have no company_code, so it can''t be required again. Choosing one is a data change for the owner, not part of a rollback. Nothing was changed.',
      (select count(*) from core.drivers where company_code is null);
  end if;
end $$;

/* 1. the dated vehicle company */
drop table core.vehicle_company_periods;
drop function private.vehicle_company_period_delete_guard();

/* 2. the driver columns */
alter table core.drivers drop column father_name, drop column date_of_birth, drop column address;
alter table core.drivers alter column company_code set not null;
comment on column core.drivers.company_code is null;

/* 3. the result */
do $$
begin
  if to_regclass('core.vehicle_company_periods') is not null or to_regprocedure('private.vehicle_company_period_delete_guard()') is not null
     or exists (select 1 from information_schema.columns where table_schema = 'core' and table_name = 'drivers' and column_name in ('father_name', 'date_of_birth', 'address'))
     or (select is_nullable from information_schema.columns where table_schema = 'core' and table_name = 'drivers' and column_name = 'company_code') <> 'NO' then
    raise exception 'Driver rollback check failed: the database is not back to its state before 20261127000000. Nothing was changed.';
  end if;
end $$;

commit;
