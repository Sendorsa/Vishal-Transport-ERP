-- READ-ONLY. Run before 20261121000100_driver_licence_unique.sql: drivers who share a DL number (compared as the app
-- stores it — whitespace runs → one space, trimmed, upper case; blank numbers ignored). No rows = safe to apply.
-- Changes nothing.
select upper(btrim(regexp_replace(license_no, '\s+', ' ', 'g'))) as dl_number,
       count(*) as drivers,
       string_agg(name || ' (' || id || ', ' || status || ')', '; ' order by id) as who
from core.drivers
where btrim(regexp_replace(license_no, '\s+', ' ', 'g')) <> ''
group by 1
having count(*) > 1
order by 1;
