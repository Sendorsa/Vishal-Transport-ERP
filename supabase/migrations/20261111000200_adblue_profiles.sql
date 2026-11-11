-- Owner's instruction, 11 Nov 2026: two AdBlue profiles. Script B of two — needs 20261111000100 COMMITTED first.
--   Tata Adblue (TATA_ADBLUE): AdBlue for the customers Dev assigns; Diesel read-only for those customers.
--   Adblue (ADBLUE): AdBlue for every customer; Diesel read-only for every customer.
-- Both may add bulk AdBlue purchases to the one shared stock pool, but never edit / delete them or touch opening stock.
-- Mirrors src/lib/permissions.ts (MAP, canChangeAdBluePurchases) and the server's per-role method list
-- (src/lib/server/erp/profiles.ts). The Owner, Dev and Employee keep exactly the access they have today.
--
-- Reads: the new roles can't reach these tables directly (the core / fuel / finance / audit schemas aren't exposed
-- through the Data API); /api/erp answers only their listed methods and filters customers on the server. Writes are
-- enforced here too: AdBlue writes need the new `adblue` resource, and Tata Adblue's customer scope is checked by RLS.
-- One transaction: the Owner / Employee `adblue:*` rows land with the policy switch, so no role loses AdBlue even briefly.
-- Apply in the Supabase SQL Editor after review.

/* ------------------------------------------------------------------ 1. the `adblue` permission resource */

insert into core.role_permissions (role, permission) values
  ('OWNER', 'adblue:*'), ('EMPLOYEE', 'adblue:*'), -- DEV holds '*'
  ('TATA_ADBLUE', 'diesel:view'), ('TATA_ADBLUE', 'adblue:*'),
  ('ADBLUE', 'diesel:view'), ('ADBLUE', 'adblue:*');

-- AdBlue audit history (and the right to write its DELETED events) follows the new resource.
create or replace function private.module_resource(module text) returns text
language sql immutable set search_path = '' as $$
  select case module
    when 'Diesel' then 'diesel' when 'AdBlue' then 'adblue' when 'Diesel Tanker' then 'diesel' when 'Fuel Stations' then 'diesel'
    when 'Payments' then 'payments' when 'Customers' then 'customers' when 'Vehicles' then 'vehicles'
    when 'Drivers' then 'settings' when 'Trips' then 'trips' when 'Invoices' then 'invoices' when 'Settings' then 'settings'
    else 'audit' end
$$;

/* ------------------------------------------------------------------ 2. Tata Adblue's customers */

-- Current grants only: revoking deletes the row, the audit trail keeps the history. AdBlue / Diesel records are never
-- touched by a grant or a revocation.
create table core.profile_customer_access (
  profile_id uuid not null references public.profiles (id),
  customer_id text not null references core.customers (id),
  granted_by uuid not null references public.profiles (id),
  granted_at timestamptz not null default now(),
  primary key (profile_id, customer_id)
);
create index profile_customer_access_customer on core.profile_customer_access (customer_id);
comment on table core.profile_customer_access is 'Customers a Tata Adblue account may work with. Changed only by public.set_customer_access / set_account_role (Dev).';

revoke all on core.profile_customer_access from public, anon, authenticated;
grant select on core.profile_customer_access to authenticated;
grant all on core.profile_customer_access to service_role;
alter table core.profile_customer_access enable row level security;
create policy "Own grants; Dev reads all" on core.profile_customer_access for select to authenticated
  using (profile_id = (select private.current_profile_id()) or (select private.is_dev()));

-- No grant or revocation without its Accounts event in the same transaction, whoever makes it (the SQL editor included).
create function private.customer_access_require_audit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  rid text := coalesce(new.profile_id, old.profile_id)::text;
begin
  if not exists (select 1 from audit.events e where e.txid = txid_current() and e.module = 'Accounts' and e.record_type = 'Customer access' and e.record_id = rid) then
    raise exception '% of core.profile_customer_access (account %) has no audit event in the same transaction.', tg_op, rid
      using errcode = 'integrity_constraint_violation';
  end if;
  return null;
end $$;
create constraint trigger profile_customer_access_require_audit after insert or update or delete on core.profile_customer_access
deferrable initially deferred for each row execute function private.customer_access_require_audit();

-- May the signed-in account work with this customer? A positive list: every other role (and no role) gets false.
create function private.customer_in_scope(p_customer_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  select case
    when private.erp_role() in ('OWNER', 'DEV', 'EMPLOYEE', 'ADBLUE') then true
    when private.erp_role() = 'TATA_ADBLUE' then exists (
      select 1 from core.profile_customer_access a where a.profile_id = private.current_profile_id() and a.customer_id = p_customer_id)
    else false
  end
$$;

-- One Accounts event per granted / revoked customer: who, when, the customer, before / after, the reason.
create function private.write_access_event(p_actor uuid, p_profile public.profiles, p_customer_id text, p_granted boolean, p_reason text, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  actor public.profiles;
  c core.customers;
  who text;
  b jsonb;
begin
  select * into strict actor from public.profiles where id = p_actor;
  select * into c from core.customers where id = p_customer_id;
  who := coalesce(nullif(btrim(c.short_name), ''), c.name, p_customer_id);
  b := jsonb_build_object('customerId', p_customer_id, 'customer', who, 'access', case when p_granted then 'Not granted' else 'Granted' end);
  insert into audit.events (actor_kind, actor_user_id, actor_name, actor_role, action, module, record_type, record_id, label, before, after, changes, reason, note)
  values ('SESSION', actor.id, coalesce(actor.full_name, actor.email), actor.role, 'UPDATED', 'Accounts', 'Customer access', p_profile.id::text,
    p_profile.email || ' · ' || who || case when p_granted then ' · access granted' else ' · access revoked' end,
    b, b || jsonb_build_object('access', case when p_granted then 'Granted' else 'Not granted' end),
    jsonb_build_array(jsonb_build_object('field', 'access', 'before', b -> 'access', 'after', case when p_granted then 'Granted' else 'Not granted' end)),
    nullif(btrim(p_reason), ''), p_note);
end $$;
revoke all on function private.write_access_event(uuid, public.profiles, text, boolean, text, text) from public, anon, authenticated;

-- Dev only (checked by name): makes a Tata Adblue account's customers exactly `p_customer_ids` — every customer added is
-- a grant, every one left out a revocation, each with its own event and the mandatory reason.
create function public.set_customer_access(p_profile_id uuid, p_customer_ids text[], p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := private.require_dev();
  p public.profiles;
  wanted text[] := coalesce((select array_agg(distinct x) from unnest(p_customer_ids) x where x is not null), '{}');
  cid text;
begin
  perform private.require_reason(p_reason);
  p := private.lock_account(p_profile_id);
  if p.role <> 'TATA_ADBLUE' and cardinality(wanted) > 0 then
    raise exception 'Customer access is only for Tata Adblue accounts.' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(wanted) x where not exists (select 1 from core.customers c where c.id = x)) then
    raise exception 'Customer not found.' using errcode = 'P0002';
  end if;
  for cid in select a.customer_id from core.profile_customer_access a where a.profile_id = p.id and a.customer_id <> all (wanted) order by 1 loop
    perform private.write_access_event(actor, p, cid, false, p_reason, null);
    delete from core.profile_customer_access where profile_id = p.id and customer_id = cid;
  end loop;
  for cid in select x from unnest(wanted) x where not exists (select 1 from core.profile_customer_access a where a.profile_id = p.id and a.customer_id = x) order by 1 loop
    perform private.write_access_event(actor, p, cid, true, p_reason, null);
    insert into core.profile_customer_access (profile_id, customer_id, granted_by) values (p.id, cid, actor);
  end loop;
end $$;
revoke all on function public.set_customer_access(uuid, text[], text) from public, anon;
grant execute on function public.set_customer_access(uuid, text[], text) to authenticated, service_role;

-- Dev only: every current grant (Settings → User accounts).
create function public.list_customer_access() returns table (profile_id uuid, customer_id text, granted_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_dev();
  return query select a.profile_id, a.customer_id, a.granted_at from core.profile_customer_access a order by 1, 2;
end $$;
revoke all on function public.list_customer_access() from public, anon;
grant execute on function public.list_customer_access() to authenticated, service_role;

-- A role change away from Tata Adblue revokes its grants, each with its event (otherwise switching back would silently
-- restore old access). Otherwise unchanged from 20261101000700.
create or replace function public.set_account_role(p_id uuid, p_role public.erp_role, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := private.require_dev();
  p public.profiles;
  before public.profiles;
  cid text;
begin
  perform private.require_reason(p_reason);
  p := private.lock_account(p_id);
  if p.role = p_role then
    return; -- nothing changes, nothing recorded
  end if;
  if p_role <> 'DEV' then
    perform private.keep_one_dev(p);
  end if;
  before := p;
  update public.profiles set role = p_role where id = p_id returning * into p;
  perform private.write_account_event('UPDATED', actor, before, p, p_reason, 'Role changed');
  for cid in select a.customer_id from core.profile_customer_access a where a.profile_id = p_id order by 1 loop
    perform private.write_access_event(actor, p, cid, false, p_reason, 'Revoked automatically: the role changed from ' || before.role::text || ' to ' || p_role::text);
    delete from core.profile_customer_access where profile_id = p_id and customer_id = cid;
  end loop;
end $$;

/* ------------------------------------------------------------------ 3. AdBlue writes: the `adblue` resource, Tata Adblue's scope */

drop policy "Read AdBlue entries" on fuel.adblue_entries;
drop policy "Add AdBlue entries" on fuel.adblue_entries;
drop policy "Edit AdBlue entries" on fuel.adblue_entries;
drop policy "Delete AdBlue entries" on fuel.adblue_entries;
create policy "Read AdBlue entries" on fuel.adblue_entries for select to authenticated using ((select private.can('adblue', 'view')));
create policy "Add AdBlue entries" on fuel.adblue_entries for insert to authenticated
  with check ((select private.can('adblue', 'create')) and private.month_open(date) and private.customer_in_scope(customer_id));
create policy "Edit AdBlue entries" on fuel.adblue_entries for update to authenticated
  using ((select private.can('adblue', 'edit')) and private.month_open(date) and private.customer_in_scope(customer_id))
  with check (private.month_open(date) and private.customer_in_scope(customer_id));
create policy "Delete AdBlue entries" on fuel.adblue_entries for delete to authenticated
  using ((select private.can('adblue', 'delete')) and private.month_open(date) and private.customer_in_scope(customer_id));

-- Bulk purchases: one shared pool, no customer. Both profiles add them; editing / deleting a purchase (it re-costs every
-- customer's draws) and opening stock stay with the Owner, Dev and Employee (is_owner_or_dev = those three).
drop policy "Read AdBlue purchases" on fuel.adblue_purchases;
drop policy "Add AdBlue purchases" on fuel.adblue_purchases;
drop policy "Edit AdBlue purchases" on fuel.adblue_purchases;
drop policy "Delete AdBlue purchases" on fuel.adblue_purchases;
create policy "Read AdBlue purchases" on fuel.adblue_purchases for select to authenticated using ((select private.can('adblue', 'view')));
create policy "Add AdBlue purchases" on fuel.adblue_purchases for insert to authenticated
  with check (private.month_open(date) and case when opening then (select private.is_owner_or_dev()) else (select private.can('adblue', 'create')) end);
create policy "Edit AdBlue purchases" on fuel.adblue_purchases for update to authenticated
  using ((select private.can('adblue', 'edit')) and (select private.is_owner_or_dev()) and private.month_open(date))
  with check (private.month_open(date));
create policy "Delete AdBlue purchases" on fuel.adblue_purchases for delete to authenticated
  using ((select private.can('adblue', 'delete')) and (select private.is_owner_or_dev()) and private.month_open(date));

/* ------------------------------------------------------------------ 4. reads no new role needs */

-- The audit trail: `audit` permission only. The dropped per-module clause gave nothing to the Owner, Dev or Employee
-- (all hold audit:view); it would have shown the new roles every Fuel / AdBlue event of every customer.
drop policy "Read audit events" on audit.events;
create policy "Read audit events" on audit.events for select to authenticated using ((select private.can('audit', 'view')));

-- Payments: `payments` permission only. The dropped `diesel:view` + DIESEL_SETTLEMENT clause likewise gave the three
-- existing roles nothing (all hold payments:view).
drop policy "Read payments" on finance.payments;
create policy "Read payments" on finance.payments for select to authenticated using ((select private.can('payments', 'view')));

/* ------------------------------------------------------------------ 5. live sync without the audit trail */

-- Which modules changed since `p_since` — names only, never events. The same rule the poll had through RLS (audit view,
-- or view of the module), plus the master modules a Diesel reader's screens show. Replaces the poll's direct read.
create function private.changed_modules(p_since timestamptz) returns setof text
language sql stable security definer set search_path = '' as $$
  select distinct e.module from audit.events e
  where e.at > p_since - interval '2 minutes'
    and ((select private.can('audit', 'view')) or private.can(private.module_resource(e.module), 'view')
         or (e.module in ('Customers', 'Vehicles', 'Month Lock') and (select private.can('diesel', 'view'))))
$$;
revoke all on function private.changed_modules(timestamptz) from public, anon;
grant execute on function private.changed_modules(timestamptz) to authenticated, service_role;
revoke all on function private.customer_in_scope(text) from public, anon;
grant execute on function private.customer_in_scope(text) to authenticated, service_role;
revoke all on function private.customer_access_require_audit() from public, anon, authenticated;
