-- Industrial Diesel comes out of the tankers (owner, 12 Nov 2026). Each industrial supply names the tanker(s) its
-- litres came from; each allocation is a draw on that tanker's stock on the supply's date — one more kind of movement
-- in the ONE tanker stock calculation (fuel.tanker_movements → private.tanker_shortfall), never a second one:
--   * fuel.industrial_supply_allocations (supply, tanker, litres): together exactly the supply's litres (checked at COMMIT);
--   * fuel.tanker_movements gains the INDUSTRIAL draws (rank 3, as a vehicle fill — src/domain/tanker.ts);
--   * the existing tanker locks (rows locked in id order before a change) and the COMMIT-time "never below zero"
--     check run on allocations, and again on a supply whose date changes;
--   * deleting a supply deletes its allocations (cascade) in the same statement: the litres go back exactly once.
-- Requires 20261112000000_industrial_diesel_supply.sql. Additive: the only existing object changed is the
-- fuel.tanker_movements view, which keeps every row it had and adds the industrial draws.

create table fuel.industrial_supply_allocations (
  supply_id text not null references fuel.industrial_supplies (id) on delete cascade,
  tanker_id text not null references fuel.tankers (id),
  litres numeric(12, 3) not null check (litres > 0),
  created_at timestamptz not null default clock_timestamp(),
  primary key (supply_id, tanker_id) -- each tanker once per supply
);
comment on table fuel.industrial_supply_allocations is 'Litres of an industrial supply drawn from each tanker. Together exactly the supply''s litres; part of the tanker stock (fuel.tanker_movements).';
create index industrial_supply_allocations_tanker_idx on fuel.industrial_supply_allocations (tanker_id);

-- The same view, one more branch: industrial draws on the supply's date and created_at (the app's event order).
create or replace view fuel.tanker_movements with (security_invoker = true) as
  select id, tanker_id, date, created_at, case when opening then 'OPENING' else 'LOAD' end as kind, litres, 0 as sort_rank from fuel.tanker_loads
  union all
  select id, tanker_id, date, created_at, 'FILL', -litres, 3 from fuel.diesel_entries where tanker_id is not null
  union all
  select id, from_tanker_id, date, created_at, 'TRANSFER_OUT', -litres, 1 from fuel.tanker_transfers
  union all
  select id, to_tanker_id, date, created_at, 'TRANSFER_IN', litres, 2 from fuel.tanker_transfers
  union all
  select id, tanker_id, date, created_at, 'ADJUST', litres, case when litres < 0 then 3 else 0 end from fuel.tanker_adjustments
  union all
  select s.id, a.tanker_id, s.date, s.created_at, 'INDUSTRIAL', -a.litres, 3 from fuel.industrial_supply_allocations a join fuel.industrial_supplies s on s.id = a.supply_id;
comment on view fuel.tanker_movements is 'Signed stock movements per tanker in the app''s event order (loads, fills, transfers, adjustments, industrial supplies). Stock and its value are calculated from these, never stored.';

-- Allocations: the existing tanker lock (BEFORE) and stock check (at COMMIT), as every other tanker movement.
create trigger industrial_supply_allocations_stock_lock before insert or update or delete on fuel.industrial_supply_allocations
  for each row execute function private.tanker_stock_lock();
create constraint trigger industrial_supply_allocations_check_stock after insert or update or delete on fuel.industrial_supply_allocations
  deferrable initially deferred for each row execute function private.tanker_stock_check();

-- A supply whose date changes moves its draws in time: lock its tankers before, and re-check them at COMMIT.
create function private.industrial_supply_stock_lock() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.date is distinct from old.date then
    perform 1 from fuel.tankers where id in (select a.tanker_id from fuel.industrial_supply_allocations a where a.supply_id = new.id) order by id for update;
  end if;
  return new;
end $$;
create trigger industrial_supplies_stock_lock before update on fuel.industrial_supplies for each row execute function private.industrial_supply_stock_lock();

create function private.industrial_supply_stock_check() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  t text;
  s record;
begin
  if new.date is distinct from old.date then
    for t in select a.tanker_id from fuel.industrial_supply_allocations a where a.supply_id = new.id order by 1 loop
      select * into s from private.tanker_shortfall(t);
      if found then
        raise exception 'Insufficient tanker inventory in %. Available: % L', (select name from fuel.tankers where id = t), round(s.available, 2)
          using errcode = 'check_violation', detail = format('Tanker %s would go below zero on %s (needs %s L).', t, s.on_date, s.needed);
      end if;
    end loop;
  end if;
  return null;
end $$;
create constraint trigger industrial_supplies_check_stock after update on fuel.industrial_supplies
  deferrable initially deferred for each row execute function private.industrial_supply_stock_check();

-- At COMMIT: a supply's allocations add up exactly to its litres (none missing, none extra).
create function private.industrial_allocation_check() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  r jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  sid text := coalesce(r ->> 'supply_id', r ->> 'id');
  want numeric;
  total numeric;
begin
  select s.litres into want from fuel.industrial_supplies s where s.id = sid;
  if not found then
    return null; -- the supply itself was deleted (its allocations with it)
  end if;
  select coalesce(sum(a.litres), 0) into total from fuel.industrial_supply_allocations a where a.supply_id = sid;
  if total <> want then
    raise exception 'The tankers'' litres (% L) must add up to the quantity supplied (% L).', total, want
      using errcode = 'check_violation', detail = format('Industrial supply %s.', sid);
  end if;
  return null;
end $$;
create constraint trigger industrial_supplies_allocation_check after insert or update on fuel.industrial_supplies
  deferrable initially deferred for each row execute function private.industrial_allocation_check();
create constraint trigger industrial_supply_allocations_total_check after insert or update or delete on fuel.industrial_supply_allocations
  deferrable initially deferred for each row execute function private.industrial_allocation_check();

-- Audit: an allocation changes only with its supply's audit event in the same transaction.
create constraint trigger industrial_supply_allocations_require_audit after insert or update or delete on fuel.industrial_supply_allocations
  deferrable initially deferred for each row execute function private.require_parent_audit_event('supply_id');

-- Grants and RLS: what the supply allows (read through the supply's own RLS; writes as for Diesel, month lock on the
-- supply's date). No UPDATE: an edit replaces the allocations. The AdBlue profiles have no diesel write permission.
revoke all on fuel.industrial_supply_allocations from public, anon, authenticated;
grant select, insert, delete on fuel.industrial_supply_allocations to authenticated;
grant all on fuel.industrial_supply_allocations to service_role;
alter table fuel.industrial_supply_allocations enable row level security;
create policy "Read industrial allocations" on fuel.industrial_supply_allocations for select to authenticated
  using (exists (select 1 from fuel.industrial_supplies s where s.id = supply_id));
create policy "Add industrial allocations" on fuel.industrial_supply_allocations for insert to authenticated
  with check (((select private.can('diesel', 'create')) or (select private.can('diesel', 'edit')))
    and exists (select 1 from fuel.industrial_supplies s where s.id = supply_id and private.month_open(s.date)));
create policy "Delete industrial allocations" on fuel.industrial_supply_allocations for delete to authenticated
  using (((select private.can('diesel', 'edit')) or (select private.can('diesel', 'delete')))
    and exists (select 1 from fuel.industrial_supplies s where s.id = supply_id and private.month_open(s.date)));

revoke all on function private.industrial_supply_stock_lock(), private.industrial_supply_stock_check(), private.industrial_allocation_check() from public, anon, authenticated;
