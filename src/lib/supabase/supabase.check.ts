/**
 * Offline checks for the Supabase foundation (no project or credentials needed):
 *  1. supabaseEnv refuses missing settings and a secret key in the public variable;
 *  2. the migrations run in a real PostgreSQL (PGlite) with a stand-in for Supabase's auth schema and roles;
 *  3. accounts (20261101000700_accounts.sql): the one-time DEV bootstrap, accounts pre-created by DEV (no email is
 *     sent), activation at the first Google sign-in (Google identity, Google-verified email = account email),
 *     DEV-only add account / role / deactivate / reactivate / recovery, the last-DEV guard, one audit event per
 *     account change (none without it, even from the database owner), and no direct writes from the browser.
 * The live connection check is `npm run supabase:ping`.
 */
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { PGlite } from "@electric-sql/pglite"
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist"
import type { Role } from "@/lib/types"
import type { Database } from "./database.types"
import { supabaseEnv } from "./env"

// The database enum must match the app's roles exactly: OWNER, DEV, EMPLOYEE. Migration 20261101000000_erp_roles_three.sql
// (approved, D-2) dropped ACCOUNTANT and OPS_MANAGER; audit history keeps them only as LegacyRole labels in the app.
type ErpRole = Database["public"]["Enums"]["erp_role"]
type AppRoles = Role
const sameRoles: [ErpRole] extends [AppRoles] ? ([AppRoles] extends [ErpRole] ? true : false) : false = true
void sameRoles

async function main() {
  /* ---------------------------------------------------------------- 1. Environment */
  delete process.env.NEXT_PUBLIC_SUPABASE_URL
  delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  assert.throws(supabaseEnv, /not configured/)
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co"
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_secret_abc"
  assert.throws(supabaseEnv, /secret key/)
  const jwt = (role: string) => `x.${Buffer.from(JSON.stringify({ role })).toString("base64url")}.y`
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = jwt("service_role")
  assert.throws(supabaseEnv, /secret key/, "legacy service_role JWT refused")
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = jwt("anon")
  assert.doesNotThrow(supabaseEnv, "legacy anon key accepted")
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_abc"
  assert.deepEqual(supabaseEnv(), { url: "https://example.supabase.co", key: "sb_publishable_abc" })

  /* ---------------------------------------------------------------- 2. Migrations */
  const db = new PGlite({ extensions: { btree_gist } }) // btree_gist: the Diesel migrations' exclusion constraints
  // Stand-in for what Supabase provides: auth.users and auth.identities, auth.uid() from the request JWT, the API
  // roles, and Supabase's defaults of granting every new public table **and function** to the API roles (so a
  // missing revoke in a migration would show up here).
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz);
    create table auth.identities (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users (id),
      provider text not null, identity_data jsonb not null, created_at timestamptz not null default now());
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  `)
  const dir = new URL("../../../supabase/migrations/", import.meta.url)
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) await db.exec(readFileSync(new URL(f, dir), "utf8"))

  // Sign-in users (auth.users + auth.identities). Google is the only real sign-in; the others prove the database
  // refuses anything else: `late` has an unverified Google email, `pw` signed up with email / password (confirmed),
  // `mix`'s Google identity has a different email from its Supabase user, `stranger` has no pre-created account.
  const u = {
    dev: "00000000-0000-0000-0000-00000000000d",
    owner: "00000000-0000-0000-0000-00000000000a",
    emp: "00000000-0000-0000-0000-00000000000b",
    late: "00000000-0000-0000-0000-00000000000c",
    stranger: "00000000-0000-0000-0000-00000000000e",
    ownerNew: "00000000-0000-0000-0000-00000000000f",
    pw: "00000000-0000-0000-0000-000000000010",
    mix: "00000000-0000-0000-0000-000000000011",
  }
  await db.exec(`insert into auth.users values
    ('${u.dev}', 'dev@example.com', now()), ('${u.owner}', 'owner@example.com', now()), ('${u.emp}', 'staff@example.com', now()),
    ('${u.late}', 'late@example.com', null), ('${u.stranger}', 'stranger@example.com', now()), ('${u.ownerNew}', 'owner.new@example.com', now()),
    ('${u.pw}', 'pw@example.com', now()), ('${u.mix}', 'mix@example.com', now());`)
  const identity = (who: string, provider: string, email: string, verified: boolean) =>
    `('${who}', '${provider}', '${JSON.stringify({ email, email_verified: verified, sub: who })}')`
  await db.exec(`insert into auth.identities (user_id, provider, identity_data) values
    ${identity(u.dev, "google", "Dev@example.com", true)}, ${identity(u.owner, "google", "owner@example.com", true)},
    ${identity(u.emp, "google", "staff@example.com", true)}, ${identity(u.stranger, "google", "stranger@example.com", true)},
    ${identity(u.ownerNew, "google", "owner.new@example.com", true)}, ${identity(u.late, "google", "late@example.com", false)},
    ${identity(u.pw, "email", "pw@example.com", true)}, ${identity(u.mix, "google", "someone.else@example.com", true)};`)

  // Runs SQL as a browser session: role anon, or authenticated as the given auth user (one transaction per call).
  const as = async <T = Record<string, unknown>>(who: string | null, sql: string) => {
    await db.exec(`set role ${who ? "authenticated" : "anon"}; select set_config('request.jwt.claim.sub', '${who ?? ""}', false);`)
    try {
      return (await db.query<T>(sql)).rows
    } finally {
      await db.exec("reset role;")
    }
  }
  const refused = async (who: string | null, sql: string, why: string, re = /permission denied|can only be changed/) =>
    assert.rejects(as(who, sql), re, why)
  const bad = (sql: string, re: RegExp, why: string) => assert.rejects(db.exec(sql), re, why)
  const profile = async (email: string) =>
    (await db.query<{ id: string; role: string; status: string; user_id: string | null }>(`select id, role::text, status::text, user_id from public.profiles where email = '${email}'`)).rows[0]
  const accountEvents = async () =>
    (await db.query<{ action: string; actor_kind: string; actor_role: string | null; record_id: string; reason: string | null }>(
      `select action::text, actor_kind::text, actor_role::text, record_id, reason from audit.events where module = 'Accounts' order by at`)).rows
  const claim = (who: string) => as<{ role: string; status: string }>(who, "select role::text, status::text from public.link_google_account()")

  /* ---------------------------------------------------------------- 3. First DEV (bootstrap) and Google sign-in */
  await db.query(`select private.bootstrap_first_dev(' Dev@Example.com ')`)
  const boot = await profile("dev@example.com")
  assert.deepEqual({ role: boot.role, status: boot.status, user_id: boot.user_id }, { role: "DEV", status: "INVITED", user_id: null }, "bootstrap: a pre-created DEV account, email normalised")
  assert.deepEqual((await accountEvents()).map((e) => [e.action, e.actor_kind]), [["CREATED", "SYSTEM"]], "bootstrap is audited as a SYSTEM event")
  await bad(`select private.bootstrap_first_dev('second@example.com')`, /already exists/, "the bootstrap works only once")
  await refused(u.dev, `select private.bootstrap_first_dev('x@example.com')`, "no session can bootstrap", /permission denied/)
  await refused(null, `select * from public.link_google_account()`, "signed-out visitors can't claim", /permission denied/)

  assert.deepEqual(await claim(u.stranger), [], "a Google account without a pre-created account gets nothing")
  assert.equal((await db.query(`select 1 from public.profiles where email = 'stranger@example.com'`)).rows.length, 0, "…and no account is created")
  assert.deepEqual(await claim(u.dev), [{ role: "DEV", status: "ACTIVE" }], "the pre-created DEV activates at first Google sign-in")
  const dev = await profile("dev@example.com")
  assert.equal(dev.user_id, u.dev, "the Google user is linked")
  assert.deepEqual(await claim(u.dev), [{ role: "DEV", status: "ACTIVE" }], "signing in again changes nothing")
  assert.equal((await as<{ r: string }>(u.dev, `select private.erp_role()::text as r`))[0].r, "DEV", "the database sees the DEV role")
  assert.equal((await as<{ d: boolean }>(u.dev, `select private.is_dev() as d`))[0].d, true, "is_dev() for DEV")

  /* ---------------------------------------------------------------- 4. DEV adds accounts; each activates at first Google sign-in */
  await as(u.dev, `select public.add_account('Owner@Example.com', 'OWNER', 'Owner One')`)
  await as(u.dev, `select public.add_account('staff@example.com', 'EMPLOYEE')`)
  await as(u.dev, `select public.add_account('late@example.com', 'EMPLOYEE')`)
  await as(u.dev, `select public.add_account('pw@example.com', 'EMPLOYEE')`)
  await as(u.dev, `select public.add_account('mix@example.com', 'EMPLOYEE')`)
  await refused(u.dev, `select public.add_account('staff@example.com', 'OWNER')`, "one account per email", /already exists/)
  await refused(u.dev, `select public.add_account('not-an-email', 'OWNER')`, "emails are checked", /check constraint/)
  assert.deepEqual(await claim(u.owner), [{ role: "OWNER", status: "ACTIVE" }], "a pre-created Owner activates")
  assert.deepEqual(await claim(u.emp), [{ role: "EMPLOYEE", status: "ACTIVE" }], "a pre-created Employee activates")
  assert.deepEqual(await claim(u.late), [], "an email Google hasn't verified can't claim an account")
  assert.equal((await profile("late@example.com")).status, "INVITED", "…which stays INVITED")
  assert.deepEqual(await claim(u.pw), [], "an email / password user can't claim an account, even with a confirmed email")
  assert.equal((await profile("pw@example.com")).status, "INVITED", "…which stays INVITED")
  assert.deepEqual(await claim(u.mix), [], "the Google-verified email must be the account's email")
  assert.equal((await profile("mix@example.com")).status, "INVITED", "…which stays INVITED")
  const owner = await profile("owner@example.com")
  const emp = await profile("staff@example.com")
  const late = await profile("late@example.com")

  // Reading accounts: DEV sees all; everyone else only their own row; signed-out visitors nothing.
  assert.equal((await as(u.dev, "select email from public.profiles")).length, 6, "DEV reads every account")
  assert.deepEqual(await as(u.emp, "select email from public.profiles"), [{ email: "staff@example.com" }], "a user sees only their own account")
  assert.deepEqual(await as(u.owner, "select email from public.profiles"), [{ email: "owner@example.com" }], "the Owner too")
  await refused(null, "select * from public.profiles", "anon can't read accounts")

  /* ---------------------------------------------------------------- 5. Only DEV manages accounts */
  for (const who of [u.owner, u.emp]) {
    await refused(who, `select public.add_account('new@example.com', 'EMPLOYEE')`, "only DEV adds accounts", /Only Dev/)
    await refused(who, `select public.set_account_role('${emp.id}', 'OWNER', 'Promotion')`, "only DEV changes roles", /Only Dev/)
    await refused(who, `select public.set_account_status('${emp.id}', 'DISABLED', 'Leaving')`, "only DEV deactivates", /Only Dev/)
    await refused(who, `select public.relink_account('${emp.id}', 'other@example.com', 'Lost phone')`, "only DEV recovers access", /Only Dev/)
  }
  await refused(null, `select public.add_account('new@example.com', 'EMPLOYEE')`, "anon can't call account functions", /permission denied/)
  await refused(u.stranger, `select public.add_account('new@example.com', 'EMPLOYEE')`, "a Google account without a pre-created account can't either", /Only Dev/)

  await refused(u.dev, `select public.set_account_role('${emp.id}', 'OWNER', 'x')`, "a role change needs a reason", /reason/)
  await as(u.dev, `select public.set_account_role('${emp.id}', 'OWNER', 'Promoted')`)
  assert.equal((await profile("staff@example.com")).role, "OWNER", "DEV changes a role")
  await as(u.dev, `select public.set_account_role('${emp.id}', 'EMPLOYEE', 'Back to staff')`)
  await as(u.dev, `select public.set_account_role('${emp.id}', 'EMPLOYEE', 'No change')`) // same role: nothing recorded

  // The last ACTIVE DEV can't be demoted, deactivated or moved away.
  await refused(u.dev, `select public.set_account_role('${dev.id}', 'OWNER', 'Step down')`, "the last DEV keeps the role", /last active Dev/)
  await refused(u.dev, `select public.set_account_status('${dev.id}', 'DISABLED', 'Leave')`, "the last DEV stays active", /last active Dev/)
  await refused(u.dev, `select public.relink_account('${dev.id}', 'dev2@example.com', 'New mail')`, "the last DEV keeps access", /last active Dev/)

  // A second DEV can cover; a deactivated DEV loses every account power; the extra DEV can be demoted again.
  await as(u.dev, `select public.set_account_role('${emp.id}', 'DEV', 'Second Dev for cover')`)
  await as(u.dev, `select public.set_account_status('${emp.id}', 'DISABLED', 'Cover ended')`) // allowed: another DEV is active
  await refused(u.emp, `select public.add_account('new2@example.com', 'EMPLOYEE')`, "a deactivated DEV can't manage accounts", /Only Dev/)
  assert.deepEqual(await as(u.emp, "select email from public.profiles"), [{ email: "staff@example.com" }], "…nor read every account")
  await as(u.dev, `select public.set_account_status('${emp.id}', 'ACTIVE', 'Back for cover')`)
  await as(u.dev, `select public.set_account_role('${emp.id}', 'EMPLOYEE', 'Cover over')`) // allowed: another DEV stays active

  // Deactivate / reactivate: access stops at once and comes back.
  await as(u.dev, `select public.set_account_status('${emp.id}', 'DISABLED', 'Left the company')`)
  assert.equal((await profile("staff@example.com")).status, "DISABLED", "DEV deactivates an account")
  assert.equal((await as<{ r: string | null }>(u.emp, `select private.erp_role()::text as r`))[0].r, null, "a deactivated account has no role")
  assert.equal((await as<{ c: boolean }>(u.emp, `select private.can('diesel', 'view') as c`))[0].c, false, "…and no business access")
  await as(u.dev, `select public.set_account_status('${emp.id}', 'DISABLED', 'Again')`) // already disabled: nothing recorded
  await refused(u.dev, `select public.relink_account('${emp.id}', 'staff2@example.com', 'New phone')`, "a deactivated account isn't moved", /Reactivate the account/)
  await refused(u.dev, `select public.set_account_status('${emp.id}', 'INVITED', 'Reset it')`, "status is only deactivate / reactivate", /only be deactivated or reactivated/)
  await as(u.dev, `select public.set_account_status('${emp.id}', 'ACTIVE', 'Rejoined')`)
  assert.equal((await profile("staff@example.com")).status, "ACTIVE", "DEV reactivates an account")
  assert.equal((await as<{ c: boolean }>(u.emp, `select private.can('diesel', 'view') as c`))[0].c, true, "…and access returns")
  await as(u.dev, `select public.set_account_status('${late.id}', 'DISABLED', 'Added by mistake')`)
  await as(u.dev, `select public.set_account_status('${late.id}', 'ACTIVE', 'Approve again')`)
  assert.equal((await profile("late@example.com")).status, "INVITED", "reactivating an account that never signed in makes it INVITED again")

  // Access recovery: the account moves to a new email; the old Google user loses access, the new one claims it.
  await refused(u.dev, `select public.relink_account('${owner.id}', 'staff@example.com', 'Wrong')`, "the new email must be free", /already exists/)
  await as(u.dev, `select public.relink_account('${owner.id}', 'Owner.New@example.com', 'Lost Google account')`)
  assert.deepEqual(await profile("owner.new@example.com"), { id: owner.id, role: "OWNER", status: "INVITED", user_id: null }, "recovery keeps the account and role")
  assert.equal((await as<{ r: string | null }>(u.owner, `select private.erp_role()::text as r`))[0].r, null, "the old Google user loses access at once")
  assert.deepEqual(await claim(u.ownerNew), [{ role: "OWNER", status: "ACTIVE" }], "the new Google user claims the same account")
  assert.equal((await profile("owner.new@example.com")).user_id, u.ownerNew, "…linked to the new Google user")

  /* ---------------------------------------------------------------- 6. Every account change is audited, and history can't change */
  const events = await accountEvents()
  assert.deepEqual(events.map((e) => e.action), [
    "CREATED", // bootstrap
    "UPDATED", // DEV activates
    "CREATED", "CREATED", "CREATED", "CREATED", "CREATED", // five accounts added (no email is sent)
    "UPDATED", "UPDATED", // Owner and Employee link their Google sign-in (refused claims recorded nothing)
    "UPDATED", "UPDATED", // role changed and changed back (the no-change call recorded nothing)
    "UPDATED", "ARCHIVED", "RESTORED", "UPDATED", // second DEV: promoted, deactivated, reactivated, demoted
    "ARCHIVED", "RESTORED", // Employee deactivated, reactivated (the repeat recorded nothing)
    "ARCHIVED", "RESTORED", // an account that never signed in: deactivated, approved again
    "UPDATED", "UPDATED", // access recovery, new Google user activates
  ], "one event per account operation, none for no-ops or refusals")
  assert.ok(events.slice(1).every((e) => e.actor_kind === "SESSION"), "every event after the bootstrap names the acting user")
  assert.ok(events.filter((e) => e.reason).every((e) => e.actor_role === "DEV"), "role and status changes are DEV's, with their reason")
  assert.equal(events.find((e) => e.reason === "Left the company")?.record_id, emp.id, "the event names the account")

  // What an account event records: before / after snapshots (never tokens or the Google user id), the changed
  // fields, the reason and the acting account.
  type Ev = { action: string; before: Record<string, unknown> | null; after: Record<string, unknown>; changes: { field: string; before: unknown; after: unknown }[]; actor_user_id: string | null; note: string | null }
  const full = (await db.query<Ev>(`select action::text, before, after, changes, actor_user_id::text, note from audit.events where module = 'Accounts' order by at`)).rows
  const added = full.find((e) => e.action === "CREATED" && e.after.email === "owner@example.com")!
  assert.equal(added.before, null, "an added account has no before")
  assert.deepEqual(Object.keys(added.after).sort(), ["activatedAt", "email", "fullName", "id", "linked", "role", "status"], "snapshots hold no tokens or Google ids")
  assert.deepEqual([added.after.role, added.after.status, added.after.linked, added.actor_user_id], ["OWNER", "INVITED", false, dev.id], "added by DEV, approved, not linked")
  assert.equal((await db.query<{ i: string }>(`select invited_by::text as i from public.profiles where id = '${owner.id}'`)).rows[0].i, dev.id, "the account records which DEV added it")
  const linked = full.find((e) => e.note?.startsWith("Activated") && e.after.id === owner.id)!
  assert.deepEqual([linked.after.status, linked.after.linked, linked.actor_user_id], ["ACTIVE", true, owner.id], "the first Google sign-in is recorded as that person")
  assert.deepEqual(linked.changes.map((c) => c.field), ["activatedAt", "linked", "status"], "…with exactly the changed fields")
  const promoted = full.find((e) => e.changes.some((c) => c.field === "role" && c.after === "OWNER"))!
  assert.deepEqual(promoted.changes, [{ field: "role", before: "EMPLOYEE", after: "OWNER" }], "a role change records before and after")

  await refused(u.dev, `insert into audit.events (actor_kind, actor_user_id, actor_role, action, module, record_type, record_id)
    values ('SESSION', '${dev.id}', 'DEV', 'CREATED', 'Accounts', 'User account', 'fake')`, "sessions can't write account events by hand", /row-level security/)
  await refused(u.dev, `select private.write_account_event('CREATED', null, null, null, null, null)`, "sessions can't call the audit writer", /permission denied/)
  await bad(`update public.profiles set full_name = 'Sneaky' where email = 'staff@example.com'`, /no audit event/, "even the database owner can't change an account without an audit event")
  await bad(`insert into public.profiles (email, role) values ('quiet@example.com', 'OWNER')`, /no audit event/, "…or create one")
  assert.equal((await profile("quiet@example.com")), undefined, "the refused insert left nothing")
  await bad(`update audit.events set reason = 'changed' where module = 'Accounts'`, /append-only/, "account events can't be edited")
  await bad(`delete from audit.events where module = 'Accounts'`, /append-only/, "…or deleted")
  assert.equal((await accountEvents()).length, events.length, "the account history is unchanged")

  /* ---------------------------------------------------------------- 7. The browser can't write accounts directly */
  await refused(u.emp, `update public.profiles set role = 'OWNER' where user_id = '${u.emp}'`, "no self-promotion")
  await refused(u.emp, `insert into public.profiles (user_id, email, role, status, activated_at) values ('${u.emp}', 'x@example.com', 'OWNER', 'ACTIVE', now())`, "no self-made Owner account")
  await refused(u.stranger, `update public.profiles set user_id = '${u.stranger}', status = 'ACTIVE' where email = 'late@example.com'`, "no taking over another pre-created account by hand")
  await refused(u.ownerNew, `update public.profiles set role = 'DEV' where user_id = '${u.emp}'`, "no role changes outside the account functions")
  await refused(u.emp, `delete from public.profiles where user_id = '${u.emp}'`, "no deleting accounts")
  // Even if an UPDATE grant is added later (e.g. to edit names), the guard still blocks role and status, and a name
  // change still needs its audit event.
  await db.exec(`grant update on public.profiles to authenticated;
    create policy "edit own" on public.profiles for update to authenticated using (user_id = auth.uid());`)
  await refused(u.emp, `update public.profiles set role = 'OWNER' where user_id = '${u.emp}'`, "guard blocks promotion despite a grant", /can only be changed/)
  await refused(u.emp, `update public.profiles set status = 'DISABLED' where user_id = '${u.emp}'`, "guard blocks status changes", /can only be changed/)
  await refused(u.emp, `update public.profiles set full_name = 'Staff One' where user_id = '${u.emp}'`, "a name change needs its audit event too", /no audit event/)

  // Constraints hold for everyone, including server-side code.
  await bad(`insert into public.profiles (email, role) values ('x@example.com', 'ADMIN')`, /invalid input value for enum/, "no roles outside the three")
  for (const removed of ["ACCOUNTANT", "OPS_MANAGER"])
    await bad(`insert into public.profiles (email, role) values ('r@example.com', '${removed}')`, /invalid input value for enum/, `${removed} was removed`)
  await bad(`insert into public.profiles (email, role) values ('Mixed@Example.com', 'EMPLOYEE')`, /check constraint/, "emails stored lower-case")
  await bad(`insert into public.profiles (email, role) values ('LATE@example.com', 'EMPLOYEE')`, /check constraint/, "case variants can't sneak past unique")
  await bad(`insert into public.profiles (email, role) values ('late@example.com', 'EMPLOYEE')`, /unique/, "one account per email")
  await bad(`insert into public.profiles (email, role, status) values ('y@example.com', 'EMPLOYEE', 'ACTIVE')`, /profiles_active_has_user/, "ACTIVE needs a linked auth user")
  await bad(`insert into public.profiles (user_id, email, role) values ('${u.stranger}', 'z@example.com', 'EMPLOYEE')`, /profiles_invited_has_no_user/, "a pre-created account isn't linked yet")
  await bad(`delete from auth.users where id = '${u.emp}'`, /foreign key/, "auth users with an account can't be deleted (disable instead)")

  // Grants: functions are never executable by anon; the bootstrap and audit writer by no API role.
  const priv = async (role: string, fn: string) => (await db.query<{ p: boolean }>(`select has_function_privilege('${role}', '${fn}', 'execute') as p`)).rows[0].p
  for (const fn of ["public.link_google_account()", "public.add_account(text, public.erp_role, text)", "public.set_account_role(uuid, public.erp_role, text)", "public.set_account_status(uuid, public.account_status, text)", "public.relink_account(uuid, text, text)"]) {
    assert.equal(await priv("anon", fn), false, `anon can't execute ${fn}`)
    assert.equal(await priv("authenticated", fn), true, `signed-in users can call ${fn} (the function checks the role)`)
  }
  for (const role of ["anon", "authenticated", "service_role"]) {
    assert.equal(await priv(role, "private.bootstrap_first_dev(text)"), false, `${role} can't bootstrap`)
    assert.equal(await priv(role, "private.write_account_event(audit.action, uuid, public.profiles, public.profiles, text, text)"), false, `${role} can't write account events`)
    for (const fn of ["private.account_snapshot(public.profiles)", "private.require_dev()", "private.require_reason(text)", "private.lock_account(uuid)", "private.keep_one_dev(public.profiles)", "private.normal_email(text)"])
      assert.equal(await priv(role, fn), false, `${role} can't call the helper ${fn}`)
  }
  for (const fn of ["public.link_google_account()", "public.add_account(text, public.erp_role, text)", "public.set_account_role(uuid, public.erp_role, text)", "public.set_account_status(uuid, public.account_status, text)", "public.relink_account(uuid, text, text)"])
    assert.equal(await priv("service_role", fn), false, `the secret key can't run ${fn} (accounts are changed only as the signed-in DEV)`)
  assert.equal(await priv("authenticated", "private.is_dev()"), true, "is_dev() is callable (the Dev-reads-all policy uses it)")
  assert.equal(await priv("anon", "private.is_dev()"), false, "…but not by anon")

  await db.close()
  console.log("supabase: env guard, accounts schema, DEV-only account management, Google-only activation, account audit, RLS, grants and role protection: all checks passed")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
