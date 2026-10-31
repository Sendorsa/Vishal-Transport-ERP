/**
 * Offline checks for the Supabase foundation (no project or credentials needed):
 *  1. supabaseEnv refuses missing settings and a secret key in the public variable;
 *  2. the migrations run in a real PostgreSQL (PGlite) with a stand-in for Supabase's auth schema and roles,
 *     and nobody signed in through the browser can create, read others', promote or activate accounts.
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
  // Stand-in for what Supabase provides: auth.users, auth.uid() from the request JWT, the API roles,
  // and Supabase's default of granting every new public table to anon and authenticated.
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  `)
  const dir = new URL("../../../supabase/migrations/", import.meta.url)
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) await db.exec(readFileSync(new URL(f, dir), "utf8"))

  const owner = "00000000-0000-0000-0000-00000000000a"
  const emp = "00000000-0000-0000-0000-00000000000b"
  await db.exec(`
    insert into auth.users values ('${owner}', 'owner@example.com'), ('${emp}', 'staff@example.com');
    insert into public.profiles (user_id, email, role, status, activated_at) values
      ('${owner}', 'owner@example.com', 'OWNER', 'ACTIVE', now()),
      ('${emp}', 'staff@example.com', 'EMPLOYEE', 'ACTIVE', now());
    insert into public.profiles (email, role) values ('invited@example.com', 'DEV');
  `)

  // Runs SQL as a browser session: role anon, or authenticated as the given auth user.
  const as = async (who: string | null, sql: string) => {
    await db.exec(`set role ${who ? "authenticated" : "anon"}; select set_config('request.jwt.claim.sub', '${who ?? ""}', false);`)
    try {
      return await db.query<Record<string, unknown>>(sql)
    } finally {
      await db.exec("reset role;")
    }
  }
  const refused = async (who: string | null, sql: string, why: string, re = /permission denied|can only be changed by the Owner/) =>
    assert.rejects(as(who, sql), re, why)

  // Reading: own row only; anonymous visitors nothing.
  assert.deepEqual((await as(emp, "select email from public.profiles")).rows, [{ email: "staff@example.com" }], "a user sees only their own account")
  await refused(null, "select * from public.profiles", "anon can't read accounts")

  // Writing through the Data API: refused for everyone signed in, the Owner included (Owner actions go through the server).
  await refused(emp, `update public.profiles set role = 'OWNER' where user_id = '${emp}'`, "no self-promotion")
  await refused(emp, `insert into public.profiles (user_id, email, role, status, activated_at) values ('${emp}', 'x@example.com', 'OWNER', 'ACTIVE', now())`, "no self-made Owner account")
  await refused(emp, `update public.profiles set user_id = '${emp}', status = 'ACTIVE' where email = 'invited@example.com'`, "no claiming another invitation")
  await refused(owner, `update public.profiles set role = 'DEV' where user_id = '${emp}'`, "no role changes from the browser, even by the Owner")
  await refused(emp, `delete from public.profiles where user_id = '${emp}'`, "no deleting accounts")

  // Even if an UPDATE grant is added later (e.g. to edit names), the guard still blocks role and status.
  await db.exec(`grant update on public.profiles to authenticated;
    create policy "edit own" on public.profiles for update to authenticated using (user_id = auth.uid());`)
  await refused(emp, `update public.profiles set role = 'OWNER' where user_id = '${emp}'`, "guard blocks promotion despite a grant", /can only be changed by the Owner/)
  await refused(emp, `update public.profiles set status = 'DISABLED' where user_id = '${emp}'`, "guard blocks status changes", /can only be changed by the Owner/)
  await as(emp, `update public.profiles set full_name = 'Staff One' where user_id = '${emp}'`)
  const staff = (await db.query<{ full_name: string; role: string; t: boolean }>(`select full_name, role, updated_at > created_at as t from public.profiles where user_id = '${emp}'`)).rows[0]
  assert.deepEqual(staff, { full_name: "Staff One", role: "EMPLOYEE", t: true }, "a harmless field can change; updated_at moves")

  // Constraints hold for everyone, including server-side code.
  const bad = (sql: string, re: RegExp, why: string) => assert.rejects(db.exec(sql), re, why)
  await bad(`insert into public.profiles (email, role) values ('x@example.com', 'ADMIN')`, /invalid input value for enum/, "no roles outside the three")
  for (const removed of ["ACCOUNTANT", "OPS_MANAGER"])
    await bad(`insert into public.profiles (email, role) values ('r@example.com', '${removed}')`, /invalid input value for enum/, `${removed} was removed`)
  await bad(`insert into public.profiles (email, role) values ('Mixed@Example.com', 'EMPLOYEE')`, /check constraint/, "emails stored lower-case")
  await bad(`insert into public.profiles (email, role) values ('INVITED@example.com', 'EMPLOYEE')`, /check constraint/, "case variants can't sneak past unique")
  await bad(`insert into public.profiles (email, role) values ('invited@example.com', 'EMPLOYEE')`, /unique/, "one account per email")
  await bad(`insert into public.profiles (email, role, status) values ('y@example.com', 'EMPLOYEE', 'ACTIVE')`, /profiles_active_has_user/, "ACTIVE needs a linked auth user")
  await bad(`insert into public.profiles (user_id, email, role) values ('${owner}', 'z@example.com', 'EMPLOYEE')`, /profiles_invited_has_no_user|unique/, "an invitation isn't linked yet")
  await bad(`delete from auth.users where id = '${emp}'`, /foreign key/, "auth users with an account can't be deleted (disable instead)")

  await db.close()
  console.log("supabase: env guard, accounts schema, RLS and role protection: all checks passed")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
