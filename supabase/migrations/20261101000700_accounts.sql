-- ERP accounts, phase 2 (M-2) — approved by the owner on 1 Nov 2026. See docs/SUPABASE_INTEGRATION_PLAN.md §3.
--
-- Only DEV manages accounts: add (pre-create), change role, deactivate / reactivate, access recovery. Each function checks
-- the DEV role by name (never private.can: OWNER's '*' permission would match anything). Every account change
-- writes its audit event in the same transaction, and a deferred check refuses any change to public.profiles —
-- including one typed into the SQL editor — that has no audit event for that account in its transaction.
--
-- Onboarding (owner's architecture): accounts are pre-created in the database by DEV with their role — no
-- invitation email is ever sent, and nobody registers themselves. A pre-created account waits as INVITED
-- ("approved, not signed in yet"). Google is the only sign-in: at a person's first Google sign-in, if Google's
-- verified email equals a pre-created account's email, that account is linked to the Google identity and becomes
-- ACTIVE. Signing in grants nothing by itself: no account, or an account that isn't ACTIVE, means no access.
--
-- Additive: no business table, no existing row and no applied migration changes. The account functions live in
-- `public` so a signed-in user can call them with their own session through the Data API; the database enforces
-- who may do what.

/* ------------------------------------------------------------------ helpers (private: not callable by sessions) */

create function private.is_dev() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(private.erp_role() = 'DEV', false)
$$;

-- What an account looks like in the audit trail. Never tokens; only whether a Google user is linked.
create function private.account_snapshot(p public.profiles) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'id', p.id, 'email', p.email, 'fullName', p.full_name, 'role', p.role, 'status', p.status,
    'linked', p.user_id is not null, 'activatedAt', p.activated_at)
$$;

-- Appends one Accounts event. p_actor null = SYSTEM (the one-time bootstrap); otherwise the acting profile.
create function private.write_account_event(
  p_action audit.action, p_actor uuid, p_before public.profiles, p_after public.profiles, p_reason text, p_note text
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  b jsonb := case when p_before.id is not null then private.account_snapshot(p_before) end;
  a jsonb := private.account_snapshot(p_after);
  actor public.profiles;
begin
  if p_actor is not null then
    select * into strict actor from public.profiles where id = p_actor;
  end if;
  insert into audit.events (actor_kind, actor_user_id, actor_name, actor_role, action, module, record_type, record_id,
                            label, before, after, changes, reason, note)
  values (
    case when p_actor is null then 'SYSTEM' else 'SESSION' end::audit.actor_kind,
    actor.id, coalesce(actor.full_name, actor.email), actor.role,
    p_action, 'Accounts', 'User account', p_after.id::text,
    p_after.email || ' · ' || p_after.role::text, b, a,
    coalesce((select jsonb_agg(jsonb_build_object('field', k, 'before', b -> k, 'after', a -> k) order by k)
                from jsonb_object_keys(a) k where b is not null and (b -> k) is distinct from (a -> k)), '[]'),
    nullif(btrim(p_reason), ''), p_note);
end $$;

create function private.require_dev() returns uuid
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_dev() then
    raise exception 'Only Dev can manage user accounts.' using errcode = '42501';
  end if;
  return private.current_profile_id();
end $$;

create function private.require_reason(p_reason text) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Enter a reason of at least 3 characters.' using errcode = '22023';
  end if;
end $$;

-- Locks the account row for the change, refusing an unknown id.
create function private.lock_account(p_id uuid) returns public.profiles
language plpgsql security definer set search_path = '' as $$
declare
  p public.profiles;
begin
  select * into p from public.profiles where id = p_id for update;
  if not found then
    raise exception 'Account not found.' using errcode = 'P0002';
  end if;
  return p;
end $$;

-- Refuses a change that would leave no ACTIVE DEV (nobody could manage accounts any more).
create function private.keep_one_dev(p public.profiles) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p.role = 'DEV' and p.status = 'ACTIVE' then
    perform 1 from public.profiles where role = 'DEV' and status = 'ACTIVE' for update; -- serialise concurrent changes
    if (select count(*) from public.profiles where role = 'DEV' and status = 'ACTIVE') <= 1 then
      raise exception 'This is the last active Dev account. Make another account Dev first.' using errcode = '42501';
    end if;
  end if;
end $$;

create function private.normal_email(p_email text) returns text
language sql immutable set search_path = '' as $$
  select lower(btrim(coalesce(p_email, '')))
$$;

/* ------------------------------------------------------------------ one-time bootstrap (SQL editor only) */

-- Pre-creates the first DEV account (INVITED until its first Google sign-in). Run once by the project administrator
-- in the SQL editor:
--   select private.bootstrap_first_dev('<email>');
-- Refused while any DEV account is INVITED or ACTIVE. Not executable by any API role.
create function private.bootstrap_first_dev(p_email text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  e text := private.normal_email(p_email);
  p public.profiles;
begin
  lock table public.profiles in share row exclusive mode;
  if exists (select 1 from public.profiles where role = 'DEV' and status in ('INVITED', 'ACTIVE')) then
    raise exception 'A Dev account already exists. Add further accounts from Settings → User accounts.' using errcode = '42501';
  end if;
  if exists (select 1 from public.profiles where email = e) then
    raise exception 'An account with this email already exists.' using errcode = '23505';
  end if;
  insert into public.profiles (email, role, status) values (e, 'DEV', 'INVITED') returning * into p;
  perform private.write_account_event('CREATED', null, null, p, null, 'First Dev account (bootstrap)');
  return p.id;
end $$;

/* ------------------------------------------------------------------ first Google sign-in */

-- First Google sign-in: links the signed-in user to the pre-created (INVITED) account whose email equals the email
-- Google verified, and activates it. Defence in depth, whatever the Auth settings: the user must have a Google
-- identity whose email Google marked verified, and the Supabase user's email must be confirmed — an email /
-- password, phone or anonymous user can never claim an account. Returns the caller's role and status, or no row
-- when the Google account matches no pre-created account.
create function public.link_google_account() returns table (role public.erp_role, status public.account_status)
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  e text;
  p public.profiles;
  before public.profiles;
begin
  if uid is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;
  select * into p from public.profiles pr where pr.user_id = uid;
  if found then -- already linked: nothing to claim
    return query select p.role, p.status;
    return;
  end if;
  select private.normal_email(i.identity_data ->> 'email') into e
  from auth.identities i
  join auth.users u on u.id = i.user_id and u.email_confirmed_at is not null
  where i.user_id = uid
    and i.provider = 'google'
    and i.identity_data ->> 'email_verified' = 'true'
    and private.normal_email(i.identity_data ->> 'email') = private.normal_email(u.email)
  order by i.created_at
  limit 1;
  if e is null or e = '' then
    return; -- no Google identity with a verified email: no access
  end if;
  select * into p from public.profiles pr where pr.email = e and pr.status = 'INVITED' for update;
  if not found then
    return; -- no pre-created account for this email (or it was deactivated)
  end if;
  before := p;
  update public.profiles pr set user_id = uid, status = 'ACTIVE', activated_at = now() where pr.id = p.id returning * into p;
  perform private.write_account_event('UPDATED', p.id, before, p, null, 'Activated at first Google sign-in');
  return query select p.role, p.status;
end $$;

/* ------------------------------------------------------------------ DEV-only account management */

create function public.add_account(p_email text, p_role public.erp_role, p_full_name text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := private.require_dev();
  e text := private.normal_email(p_email);
  p public.profiles;
begin
  if exists (select 1 from public.profiles where email = e) then
    raise exception 'An account with this email already exists.' using errcode = '23505';
  end if;
  insert into public.profiles (email, full_name, role, status, invited_by)
  values (e, nullif(btrim(p_full_name), ''), p_role, 'INVITED', actor) returning * into p;
  perform private.write_account_event('CREATED', actor, null, p, null, 'Account added (activates at first Google sign-in)');
  return p.id;
end $$;

create function public.set_account_role(p_id uuid, p_role public.erp_role, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := private.require_dev();
  p public.profiles;
  before public.profiles;
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
end $$;

-- p_status: DISABLED (deactivate, including an account that never signed in) or ACTIVE (reactivate: back to ACTIVE
-- when a Google user is linked, back to INVITED — approved, not signed in yet — when it never signed in).
create function public.set_account_status(p_id uuid, p_status public.account_status, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := private.require_dev();
  p public.profiles;
  before public.profiles;
  target public.account_status;
begin
  perform private.require_reason(p_reason);
  if p_status not in ('ACTIVE', 'DISABLED') then
    raise exception 'An account can only be deactivated or reactivated.' using errcode = '22023';
  end if;
  p := private.lock_account(p_id);
  target := case when p_status = 'DISABLED' then 'DISABLED' when p.user_id is null then 'INVITED' else 'ACTIVE' end;
  if p.status = target or (p_status = 'ACTIVE' and p.status <> 'DISABLED') then
    return; -- nothing changes, nothing recorded
  end if;
  if target = 'DISABLED' then
    perform private.keep_one_dev(p);
  end if;
  before := p;
  update public.profiles set status = target, activated_at = case when target = 'ACTIVE' then coalesce(activated_at, now()) else activated_at end
  where id = p_id returning * into p;
  perform private.write_account_event(case when target = 'DISABLED' then 'ARCHIVED' else 'RESTORED' end::audit.action,
    actor, before, p, p_reason, case when target = 'DISABLED' then 'Deactivated' else 'Reactivated' end);
end $$;

-- Access recovery: the account moves to a new email (e.g. a lost Google account). The old Google user loses access
-- at once; the next Google sign-in with the new email claims the same account, keeping its role and history.
create function public.relink_account(p_id uuid, p_new_email text, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := private.require_dev();
  e text := private.normal_email(p_new_email);
  p public.profiles;
  before public.profiles;
begin
  perform private.require_reason(p_reason);
  p := private.lock_account(p_id);
  if exists (select 1 from public.profiles where email = e and id <> p_id) then
    raise exception 'An account with this email already exists.' using errcode = '23505';
  end if;
  if p.status = 'DISABLED' then
    raise exception 'Reactivate the account before moving it to a new email.' using errcode = '22023';
  end if;
  perform private.keep_one_dev(p);
  before := p;
  update public.profiles set email = e, user_id = null, status = 'INVITED', activated_at = null
  where id = p_id returning * into p;
  perform private.write_account_event('UPDATED', actor, before, p, p_reason, 'Access recovery: moved to a new email');
end $$;

/* ------------------------------------------------------------------ guards, policies and grants */

-- The browser roles still can't write accounts directly (unchanged rule; only the message is updated).
create or replace function public.profiles_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user in ('anon', 'authenticated') and (
    tg_op <> 'UPDATE'
    or (new.user_id, new.email, new.role, new.status, new.invited_by, new.activated_at, new.created_at)
       is distinct from (old.user_id, old.email, old.role, old.status, old.invited_by, old.activated_at, old.created_at)
  ) then
    raise exception 'ERP accounts can only be changed through Settings → User accounts (Dev).' using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;

-- No account change without its audit event — whoever makes it, the SQL editor included.
create constraint trigger profiles_require_audit after insert or update or delete on public.profiles
deferrable initially deferred for each row execute function private.require_audit_event('id');

-- DEV sees every account (Settings → User accounts); everyone else still sees only their own row.
create policy "Dev reads all accounts" on public.profiles for select to authenticated using ((select private.is_dev()));

-- Account events come only from the functions above, never from a session directly.
drop policy "Write own audit events" on audit.events;
create policy "Write own audit events" on audit.events for insert to authenticated
  with check (
    actor_kind = 'SESSION'
    and actor_user_id = (select private.current_profile_id())
    and actor_role = (select private.erp_role())
    and module <> 'Accounts'
    and action <> 'DATA_RESET'
    and (action <> 'DELETED' or private.can(private.module_resource(module), 'delete')) -- no deletion events without the right to delete
    and (restores_event_id is null or (select private.is_owner()))
    and (action not in ('MONTH_LOCKED', 'MONTH_UNLOCKED') or (select private.is_owner()))
  );

-- Functions are executable by PUBLIC by default: take that back, then grant only what sessions need.
revoke all on function
  private.is_dev(), private.account_snapshot(public.profiles),
  private.write_account_event(audit.action, uuid, public.profiles, public.profiles, text, text),
  private.require_dev(), private.require_reason(text), private.lock_account(uuid), private.keep_one_dev(public.profiles),
  private.normal_email(text), private.bootstrap_first_dev(text),
  public.link_google_account(), public.add_account(text, public.erp_role, text),
  public.set_account_role(uuid, public.erp_role, text), public.set_account_status(uuid, public.account_status, text),
  public.relink_account(uuid, text, text)
from public, anon, authenticated, service_role;

grant execute on function private.is_dev() to authenticated; -- used by the "Dev reads all accounts" policy
grant execute on function
  public.link_google_account(), public.add_account(text, public.erp_role, text),
  public.set_account_role(uuid, public.erp_role, text), public.set_account_status(uuid, public.account_status, text),
  public.relink_account(uuid, text, text)
to authenticated;
