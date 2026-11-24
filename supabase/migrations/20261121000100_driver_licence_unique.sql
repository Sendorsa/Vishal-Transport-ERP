-- One DL number, one driver — in the database (owner, 21 Nov 2026). Run ONCE in the Supabase Dashboard → SQL Editor as
-- one script, after 20261121000000_vehicle_puc_and_drivers.sql (it doesn't depend on it; kept separate so existing data
-- can stop it on its own). It opens its own transaction: any error — or the guard below — changes nothing.
-- Run supabase/scripts/production-readonly/19-driver-licence-duplicates.sql first: it lists any duplicates.
--
-- The app already refuses a DL number another driver holds (src/lib/api/index.ts licenceOf) and stores it cleaned
-- (src/domain/compliance.ts cleanLicenceNo: whitespace runs → one space, trimmed, upper case). This adds the same rule
-- as a database backstop: a unique index on that normalised form, for non-blank numbers only — a blank DL ('' or only
-- spaces; the column is NOT NULL default '') stays allowed for any number of drivers.
--
-- Existing data: if two drivers already share a normalised DL number, the guard stops with their ids and names and
-- NOTHING is changed — no driver's details are edited or removed here. Correct them in the app (vehicle page → Drivers &
-- DL numbers → ✏️), then run this again.
--
-- Changes: one unique index (core.drivers_license_no_key). No row, column, grant or policy changes.
-- Verify afterwards: select indexdef from pg_indexes where schemaname = 'core' and indexname = 'drivers_license_no_key';
-- Rollback: drop index core.drivers_license_no_key;

begin;

do $$
declare
  dups text;
begin
  if to_regclass('core.drivers') is null
     or not exists (select 1 from information_schema.columns where table_schema = 'core' and table_name = 'drivers' and column_name = 'license_no') then
    raise exception 'DL uniqueness migration stopped: apply 20261103000200 first (core.drivers.license_no). Nothing was changed.';
  end if;
  if to_regclass('core.drivers_license_no_key') is not null then
    raise exception 'DL uniqueness migration stopped: it is already applied. Nothing was changed.';
  end if;
  select string_agg(k || ': ' || who, '; ' order by k) into dups
  from (
    select upper(btrim(regexp_replace(license_no, '\s+', ' ', 'g'))) as k,
           string_agg(name || ' (' || id || ')', ', ' order by id) as who
    from core.drivers
    where btrim(regexp_replace(license_no, '\s+', ' ', 'g')) <> ''
    group by 1
    having count(*) > 1
  ) d;
  if dups is not null then
    raise exception 'DL uniqueness migration stopped: these drivers share a DL number — %. Correct them in the app, then run this again. Nothing was changed.', dups;
  end if;
end $$;

create unique index drivers_license_no_key on core.drivers (upper(btrim(regexp_replace(license_no, '\s+', ' ', 'g'))))
  where btrim(regexp_replace(license_no, '\s+', ' ', 'g')) <> '';

commit;
