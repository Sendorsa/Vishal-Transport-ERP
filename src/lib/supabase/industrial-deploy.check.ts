/**
 * Runnable check of the Industrial Diesel Production safeguards (offline, in-memory PostgreSQL):  npm run check:industrial-deploy
 *
 *   1. The two migrations are exactly the reviewed files (md5) — they must never change after review.
 *   2. 07-industrial-preflight.sql: no STOP before the migrations (with and without the month lock); STOP on every
 *      name conflict and on the replaced view once they are applied; STOP when a tanker function or policy differs.
 *   3. 08-industrial-post-apply-fingerprint.sql: all OK after both migrations; only the month lock's objects when
 *      that migration is missing; only the 53 industrial objects before them; a tampered object is UNEXPECTED.
 *   4. 06-rollback-industrial-diesel.sql: refused without the typed confirmation and when nothing is installed;
 *      otherwise (both migrations, or migration 1 only) the schema is exactly the pre-migration state (original view and comment), business data and the
 *      audit trail untouched, the supplied litres back in the tanker.
 * States are built from the migration files up to 20261112000100 only, so later migrations never change this check.
 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { PGlite } from "@electric-sql/pglite"
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist"

const MIGRATIONS = new URL("../../../supabase/migrations/", import.meta.url)
const SCRIPTS = new URL("../../../supabase/scripts/", import.meta.url)
const M1 = "20261112000000_industrial_diesel_supply.sql"
const M2 = "20261112000100_industrial_tanker_allocations.sql"
const MONTH_LOCK = "20261111000000_month_lock_owner_dev.sql"
const read = (base: URL, f: string) => readFileSync(new URL(f, base), "utf8")
type Row = Record<string, string>

async function build(filter: (f: string) => boolean) {
  const db = new PGlite({ extensions: { btree_gist } })
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key, email text);
    create table auth.identities (id uuid primary key default gen_random_uuid(), user_id uuid references auth.users (id), provider text, identity_data jsonb, created_at timestamptz default now());
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;`)
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql") && f <= M2 && filter(f)).sort()) await db.exec(read(MIGRATIONS, f))
  return db
}
const PRE = (f: string) => f !== M1 && f !== M2
const PRE_NOML = (f: string) => PRE(f) && f !== MONTH_LOCK
const POST = () => true
const POST_NOML = (f: string) => f !== MONTH_LOCK

async function main() {
  /* ---------------------------------------------------------------- 1. the reviewed migrations */
  const md5 = (f: string) => createHash("md5").update(readFileSync(new URL(f, MIGRATIONS))).digest("hex")
  assert.equal(md5(M1), "89815f5432a4f16e2c94aad1a5c4d603", `${M1} changed after review`)
  assert.equal(md5(M2), "88d61a60e2af272fbb4cbcd12fedd1ca", `${M2} changed after review`)

  const f07 = read(SCRIPTS, "production-readonly/07-industrial-preflight.sql")
  const f08 = read(SCRIPTS, "production-readonly/08-industrial-post-apply-fingerprint.sql")
  const f06 = read(SCRIPTS, "06-rollback-industrial-diesel.sql")
  const actual = f08.slice(f08.indexOf("\nactual as (") + 1, f08.indexOf("\ncmp as (")).replace(/,\s*$/, "")
  const fingerprint = async (db: PGlite) => new Map((await db.query<Row>(`with ${actual} select kind, name, fp from actual`)).rows.map((r) => [`${r.kind} ${r.name}`, r.fp]))
  const run = async (db: PGlite, sql: string) => (await db.query<Row>(sql)).rows
  const stops = (rows: Row[]) => rows.filter((r) => r.status === "STOP").map((r) => `${r.check_no} ${r.check_name}`)
  const notOk = (rows: Row[]) => rows.filter((r) => r.kind !== "SUMMARY")

  /* ---------------------------------------------------------------- 2. pre-flight */
  for (const filter of [PRE, PRE_NOML]) {
    const db = await build(filter)
    assert.deepEqual(stops(await run(db, f07)), [], "before the migrations: no STOP")
    await db.close()
  }
  {
    const db = await build(POST)
    const s = stops(await run(db, f07))
    for (const n of [20, 21, 22, 23, 24, 25]) assert.ok(s.some((x) => x.startsWith(`${n} `)), `applied: name conflict row ${n} stops`)
    assert.ok(s.some((x) => x.endsWith("view fuel.tanker_movements")), "applied: the replaced view stops")
    await db.close()
  }
  {
    const db = await build(PRE)
    await db.exec(`create or replace function private.tanker_stock_lock() returns trigger language plpgsql security definer set search_path = '' as $$ begin return coalesce(new, old); end $$;
                   drop policy "Read tanker loads" on fuel.tanker_loads;`)
    const s = stops(await run(db, f07))
    assert.ok(s.some((x) => x.endsWith("function private.tanker_stock_lock()")) && s.some((x) => x.endsWith("policy fuel.tanker_loads.Read tanker loads")), "a changed stock function or tanker policy stops")
    await db.close()
  }

  /* ---------------------------------------------------------------- 3. post-apply fingerprint */
  {
    const db = await build(POST)
    const rows = await run(db, f08)
    assert.match(rows[0].status, /^expected (\d+) · OK \1 · MISSING 0 · DIFFERENT 0 · EXTRA 0 · UNEXPECTED 0$/, "after both migrations: all OK")
    assert.deepEqual(notOk(rows), [])
    await db.exec(`drop policy "Read tanker loads" on fuel.tanker_loads`)
    assert.deepEqual(notOk(await run(db, f08)).map((r) => [r.status, r.name, r.belongs_to]), [["MISSING", "fuel.tanker_loads.Read tanker loads", "UNEXPECTED"]], "anything else: UNEXPECTED")
    await db.close()
  }
  {
    const db = await build(POST_NOML)
    const o = notOk(await run(db, f08))
    assert.ok(o.length === 5 && o.every((r) => r.belongs_to === "month-lock migration 20261111000000"), "without the month lock: only its 5 objects")
    await db.close()
  }
  {
    const db = await build(PRE)
    const o = notOk(await run(db, f08))
    assert.equal(o.length, 53)
    assert.ok(o.every((r) => r.belongs_to.startsWith("industrial migrations")), "before the migrations: only their 53 objects")
    assert.deepEqual(o.filter((r) => r.status === "DIFFERENT").map((r) => r.name), ["fuel.tanker_movements"], "…the one changed existing object: the view")
    await db.close()
  }

  /* ---------------------------------------------------------------- 4. rollback */
  const step1 = f06.slice(f06.indexOf("-- STEP 1"), f06.indexOf("-- STEP 2"))
  const step2 = f06.slice(f06.indexOf("\nbegin;") + 1, f06.lastIndexOf("commit;") + "commit;".length)
  const pre = await build(PRE)
  const fpPre = await fingerprint(pre)
  await pre.close()
  const db = await build(POST)
  await db.exec(`set session_replication_role = replica;
    insert into fuel.tankers (id, name, reg_no) values ('tnk_rb', 'RB', 'KA00RB0001');
    insert into fuel.tanker_loads (id, tanker_id, date, station_id, litres, rate, amount) values ('tkl_rb', 'tnk_rb', '2026-11-01', 'dv_x', 100, 90, 9000);
    insert into fuel.industrial_supplies (id, customer_id, date, litres, rate, purpose) values ('ind_rb', 'cus_rb', '2026-11-02', 40, 92, 'Generator operation');
    insert into fuel.industrial_supply_allocations (supply_id, tanker_id, litres) values ('ind_rb', 'tnk_rb', 40);
    insert into audit.events (actor_kind, action, module, record_type, record_id) values ('SYSTEM', 'CREATED', 'Diesel', 'Industrial supply', 'ind_rb');
    set session_replication_role = origin;`)
  const state = async () => ({
    loads: (await run(db, `select count(*)::text as n from fuel.tanker_loads`))[0].n,
    tankers: (await run(db, `select count(*)::text as n from fuel.tankers`))[0].n,
    events: (await run(db, `select count(*)::text as n from audit.events`))[0].n,
    stock: (await run(db, `select sum(litres)::text as s from fuel.tanker_movements where tanker_id = 'tnk_rb'`))[0].s,
  })
  const before = await state()
  assert.equal(before.stock, "60.000", "with the supply: 100 − 40")
  const backup = (await db.query<{ industrial_backup: { industrial_supplies: { id: string; allocations: { tanker_id: string }[] }[] } }>(step1)).rows[0].industrial_backup
  assert.deepEqual(backup.industrial_supplies.map((x) => [x.id, x.allocations.map((a) => a.tanker_id)]), [["ind_rb", ["tnk_rb"]]], "STEP 1: every supply with its allocations")
  await assert.rejects(db.exec(step2), /Not confirmed/, "without the typed confirmation: refused")
  await db.exec("rollback")
  assert.ok((await run(db, `select to_regclass('fuel.industrial_supplies')::text as t`))[0].t, "…and nothing changed")
  await db.exec(`select set_config('vt.confirm_industrial_rollback', 'dqnoducqiootfvkzskhu', false)`)
  await db.exec(step2)
  const fpAfter = await fingerprint(db)
  assert.deepEqual([...new Set([...fpPre.keys(), ...fpAfter.keys()])].filter((k) => fpPre.get(k) !== fpAfter.get(k)), [], "rolled back: exactly the pre-migration schema (view, functions, grants, policies, tables)")
  assert.equal((await run(db, `select obj_description('fuel.tanker_movements'::regclass) as c`))[0].c, "Signed stock movements per tanker in the app's event order. Stock and its value are calculated from these, never stored.", "the view's original comment")
  assert.deepEqual(await state(), { ...before, stock: "100.000" }, "tanker loads, tankers and the audit trail untouched; the 40 L back in the tanker")
  await assert.rejects(db.exec(step2), /not installed/, "a second run: refused")
  await db.exec("rollback")
  await db.close()
  // Only migration 1 applied (migration 2 failed): the same script rolls it back to the same pre-migration schema.
  const half = await build((f) => f !== M2)
  await half.exec(`select set_config('vt.confirm_industrial_rollback', 'dqnoducqiootfvkzskhu', false)`)
  await half.exec(step2)
  const fpHalf = await fingerprint(half)
  assert.deepEqual([...new Set([...fpPre.keys(), ...fpHalf.keys()])].filter((k) => fpPre.get(k) !== fpHalf.get(k)), [], "migration 1 only: rolled back to exactly the pre-migration schema")
  await half.close()

  console.log("industrial deploy safeguards: migrations unchanged (md5), pre-flight, post-apply fingerprint and rollback verified offline: all checks passed")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
