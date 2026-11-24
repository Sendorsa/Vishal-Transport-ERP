/**
 * Runnable check of the vehicle documents Production safeguards (offline, in-memory PostgreSQL):  npm run check:vehicle-documents-deploy
 *
 *   1. The four migrations are exactly the reviewed files (md5), each with its own BEGIN / COMMIT.
 *   2. Prerequisites: 20261121000000 stops with nothing changed when btree_gist is missing (checked, never assumed or
 *      created); 20261122000000 stops before 20261121000000; 20261122000100 stops before 20261122000000; each stops when
 *      run a second time.
 *   3. The four-stage deployment on a Production-like state (every earlier migration, a customer, a vehicle with its
 *      documents, two drivers with DL numbers): 20-vehicle-documents-preflight.sql — every CHECK OK; stage 1 (the three
 *      migrations) → 21-vehicle-documents-post-apply.sql and 10-adblue-vendors-post-apply.sql OK; stage 3
 *      22-vehicle-document-alerts-activation-preflight.sql (only "no app save yet" open); stage 4 (20261122000100) →
 *      23-vehicle-document-alerts-enforcement-post-apply.sql OK; the existing vehicle and drivers unchanged throughout.
 *   4. Between the stages: the PREVIOUS app (no history rows) keeps saving after stage 1 — even an expiry date inside
 *      its warning period; the 22 verifier passes the new app's saves and STOPs on a save missing its row; after stage 4
 *      the previous app's kind of save is refused and the new app's accepted.
 *   5. Rollback, newest first, exactly as documented in each file: every new object gone, the data as before, and the
 *      pre-flight OK again; rolling back 20261122000000 while stage 4 is still applied changes nothing.
 *   The rules themselves (engine + RLS, duplicates, every role): check:erp-db; the alert lifecycle: check:document-alerts.
 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { PGlite } from "@electric-sql/pglite"
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist"
import { todayISO } from "@/lib/format"

const MIGRATIONS = new URL("../../../supabase/migrations/", import.meta.url)
const SCRIPTS = new URL("../../../supabase/scripts/production-readonly/", import.meta.url)
const PUC = "20261121000000_vehicle_puc_and_drivers.sql"
const DL = "20261121000100_driver_licence_unique.sql"
const ALERTS = "20261122000000_vehicle_document_alerts.sql"
const ENFORCE = "20261122000100_vehicle_document_alert_enforcement.sql"
const REVIEWED: Record<string, string> = {
  [PUC]: "9528efa8c943e3d26cb24ca495f9895e",
  [DL]: "7a649f9073b4af1e4fa7389c23b41293",
  [ALERTS]: "932379bd0b408da51a94db703b64dd58",
  [ENFORCE]: "9ae0e83ac44401b372b98d826197b036",
}
// The rollback each file documents (its header comment), newest first.
const ROLLBACK: [string, string][] = [
  [ENFORCE, "drop trigger vehicles_document_alerts on core.vehicles;"],
  [ALERTS, "begin; drop table core.vehicle_document_alerts; drop function private.vehicle_document_alert_lifecycle(); drop function private.vehicle_document_alert_guard(); commit;"],
  [DL, "drop index core.drivers_license_no_key;"],
  [PUC, "begin; drop table core.vehicle_driver_periods; drop function private.vehicle_driver_period_delete_guard(); alter table core.vehicles drop column puc_valid_till; commit;"],
]
const read = (base: URL, f: string) => readFileSync(new URL(f, base), "utf8")
type Row = Record<string, string>

async function database(upTo: string) {
  const db = new PGlite({ extensions: { btree_gist } })
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key, email text);
    create table auth.identities (id uuid primary key default gen_random_uuid(), user_id uuid references auth.users (id), provider text, identity_data jsonb, created_at timestamptz default now());
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated;`)
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql") && f < upTo).sort()) await db.exec(read(MIGRATIONS, f))
  return db
}
const run = async (db: PGlite, sql: string) => (await db.query<Row>(sql)).rows
const stops = async (db: PGlite, sql: string) => (await run(db, sql)).filter((r) => r.status === "STOP").map((r) => `${r.check_no} ${r.check_name}: ${r.actual}`)
const stopNos = async (db: PGlite, sql: string) => (await stops(db, sql)).map((r) => r.split(" ")[0])
const refused = async (db: PGlite, sql: string, why: RegExp, msg: string) => {
  await assert.rejects(db.exec(sql), why, msg)
  await db.exec("rollback").catch(() => undefined)
}
const objects = async (db: PGlite) =>
  (await run(db, `select concat_ws(',', to_regclass('core.vehicle_driver_periods'), to_regclass('core.vehicle_document_alerts'), to_regclass('core.drivers_license_no_key'),
     to_regprocedure('private.vehicle_driver_period_delete_guard()'), to_regprocedure('private.vehicle_document_alert_guard()'),
     to_regprocedure('private.vehicle_document_alert_lifecycle()'), (select tgname from pg_trigger where tgrelid = 'core.vehicles'::regclass and tgname = 'vehicles_document_alerts'),
     (select 'puc_valid_till' from information_schema.columns where table_schema = 'core' and table_name = 'vehicles' and column_name = 'puc_valid_till')) as o`))[0].o

/** yyyy-MM-dd, n days after today (IST). */
const ahead = (n: number) => new Date(Date.parse(todayISO()) + n * 86_400_000).toISOString().slice(0, 10)
const ev = (module: string, type: string, id: string) => `insert into audit.events (actor_kind, action, module, record_type, record_id) values ('SYSTEM', 'CREATED', '${module}', '${type}', '${id}');`
/** The Production-like data every earlier migration leaves: a customer, two drivers and a vehicle with its documents. */
const seed = (db: PGlite) =>
  db.exec(`begin;
    insert into core.customers (id, code, short_name, name, company_code) values ('cus_a', 'MINDA', 'Minda', 'Minda Industries', 'VTHPL');
    insert into core.customer_status_periods (customer_id, status, start_date) values ('cus_a', 'ACTIVE', '2026-01-01');
    ${ev("Customers", "Customer", "cus_a")}
    insert into core.drivers (id, name, company_code, license_no) values ('drv_1', 'Ravi', 'VT', 'TN70 20110001234'), ('drv_2', 'Mani', 'VT', '');
    ${ev("Drivers", "Driver", "drv_1")} ${ev("Drivers", "Driver", "drv_2")}
    insert into core.vehicles (id, reg_no, company_code, type_code, fuel_type, assigned_customer_id, default_driver_id, insurance_valid_till, road_tax_valid_till, fitness_valid_till, permit_valid_till)
      values ('veh_1', 'TN70AM1921', 'VT', 'BUS_41', 'DIESEL', 'cus_a', 'drv_1', '2026-11-25', '2027-03-31', '2027-01-10', '2026-11-01');
    insert into core.vehicle_status_periods (vehicle_id, status, start_date) values ('veh_1', 'ACTIVE', '2026-01-01');
    insert into core.vehicle_assignments (vehicle_id, customer_id, start_date) values ('veh_1', 'cus_a', '2026-01-01');
    ${ev("Vehicles", "Vehicle", "veh_1")}
    commit;`)

/**
 * One vehicle save of veh_1's insurance date, as an app writes it (one transaction): the UPDATE, the history row when
 * given, the UPDATED audit event. The previous app's snapshots have no driverPeriods; the new app's always do.
 */
const insuranceSave = (from: string, to: string, app: "previous" | "new", alertRow: boolean) => {
  const snap = (d: string) => JSON.stringify({ status: "ACTIVE", insurance: { validTill: d }, ...(app === "new" ? { driverPeriods: [] } : {}) })
  return `begin;
    update core.vehicles set insurance_valid_till = '${to}' where id = 'veh_1';
    ${alertRow ? `insert into core.vehicle_document_alerts (vehicle_id, document, reg_no, expiry_date, alert_date, new_expiry_date, vehicle_version)
       values ('veh_1', 'Insurance', 'TN70AM1921', '${from}', '${new Date(Date.parse(from) - 7 * 86_400_000).toISOString().slice(0, 10)}', '${to}', (select updated_at from core.vehicles where id = 'veh_1'));` : ""}
    insert into audit.events (actor_kind, action, module, record_type, record_id, before, after) values ('SYSTEM', 'UPDATED', 'Vehicles', 'Vehicle', 'veh_1', '${snap(from)}'::jsonb, '${snap(to)}'::jsonb);
    commit;`
}
const insurance = async (db: PGlite) => (await run(db, `select insurance_valid_till::text as d from core.vehicles where id = 'veh_1'`))[0].d

async function main() {
  /* ---------------------------------------------------------------- 1. the reviewed migrations */
  const sql = Object.fromEntries(Object.keys(REVIEWED).map((f) => [f, read(MIGRATIONS, f)]))
  for (const [f, hash] of Object.entries(REVIEWED)) {
    assert.equal(createHash("md5").update(sql[f]).digest("hex"), hash, `${f} changed after review`)
    assert.match(sql[f], /^begin;$/m, `${f}: its own transaction`)
    assert.match(sql[f], /^commit;\s*$/m)
  }
  assert.doesNotMatch(sql[ALERTS], /^create constraint trigger vehicles_document_alerts/m, "stage 1 never activates the enforcement")
  assert.match(sql[ENFORCE], /^create constraint trigger vehicles_document_alerts after insert or update on core\.vehicles$/m, "stage 4 is the trigger")
  const flat = (s: string) => s.replace(/^--\s?/gm, "").replace(/\s+/g, " ")
  for (const [f, rb] of ROLLBACK) assert.ok(flat(sql[f]).includes(rb), `${f} documents its rollback: ${rb}`)
  const preflight = read(SCRIPTS, "20-vehicle-documents-preflight.sql")
  const postApply = read(SCRIPTS, "21-vehicle-documents-post-apply.sql")
  const activation = read(SCRIPTS, "22-vehicle-document-alerts-activation-preflight.sql")
  const postEnforce = read(SCRIPTS, "23-vehicle-document-alerts-enforcement-post-apply.sql")
  const post10 = read(SCRIPTS, "10-adblue-vendors-post-apply.sql")

  /* ---------------------------------------------------------------- 2. prerequisites */
  {
    const db = await database(PUC)
    await db.exec("drop extension btree_gist cascade") // a database without it (drops the three earlier exclusion constraints too)
    assert.deepEqual(await stops(db, preflight), ["1 btree_gist extension installed (needed by the driver-period no-overlap rule): missing"], "pre-flight: STOP on btree_gist alone")
    await refused(db, sql[PUC], /btree_gist extension is not installed/, "20261121000000 stops without btree_gist")
    assert.equal(await objects(db), "", "…and changes nothing")
  }
  {
    const db = await database(PUC)
    await refused(db, sql[ALERTS], /apply 20261103000200 … 20261121000000 first/, "20261122000000 stops before 20261121000000")
    await refused(db, sql[ENFORCE], /apply 20261122000000 first/, "20261122000100 stops before 20261122000000")
    assert.equal(await objects(db), "", "…and changes nothing")
  }

  /* ---------------------------------------------------------------- 3. Production-like: the four stages */
  const db = await database(PUC)
  await seed(db)
  const fingerprint = `select (select jsonb_agg(to_jsonb(v) - 'puc_valid_till' order by id) from core.vehicles v)::text || (select jsonb_agg(to_jsonb(d) order by id) from core.drivers d)::text as f`
  const data0 = (await run(db, fingerprint))[0].f
  assert.deepEqual(await stops(db, preflight), [], "pre-flight: every CHECK row OK")
  assert.match((await run(db, preflight)).find((r) => Number(r.check_no) === 2)!.actual, /core\.customer_status_periods, core\.vehicle_assignments, core\.vehicle_status_periods/, "btree_gist already in use by the applied exclusion constraints")

  // Stage 1: the three migrations.
  await db.exec(sql[PUC])
  await db.exec(sql[DL])
  await db.exec(sql[ALERTS])
  assert.deepEqual(await stops(db, postApply), [], "21 post-apply: every CHECK row OK (enforcement not active yet)")
  assert.deepEqual(await stops(db, post10), [], "10-adblue-vendors-post-apply: every row OK after stage 1")
  assert.equal((await run(db, fingerprint))[0].f, data0, "the existing vehicle and drivers unchanged")
  assert.deepEqual(await run(db, `select puc_valid_till, (select count(*)::int from core.vehicle_driver_periods) as p, (select count(*)::int from core.vehicle_document_alerts) as a from core.vehicles`), [{ puc_valid_till: null, p: 0, a: 0 }], "PUC not recorded, no driver period, no alert history invented")
  assert.deepEqual(await stopNos(db, preflight), ["4", "5", "6"], "the pre-flight now says stage 1 is applied, stage 4 not")
  // Stage 3 before any app save: only "the app has saved a vehicle" is open.
  assert.deepEqual(await stopNos(db, activation), ["3"], "22 before the app has saved anything: STOP on row 3 alone")

  // Stage 4.
  await db.exec(sql[ENFORCE])
  assert.deepEqual(await stops(db, postEnforce), [], "23 post-apply: every CHECK row OK")
  assert.deepEqual(await stops(db, post10), [], "10-adblue-vendors-post-apply: every row OK after stage 4")
  assert.deepEqual(await stopNos(db, postApply), ["14"], "21 now differs only in row 14 (enforcement active)")
  assert.deepEqual(await stopNos(db, preflight), ["4", "5", "6", "7"], "the pre-flight says all four are applied")
  assert.equal((await run(db, fingerprint))[0].f, data0, "the existing vehicle and drivers still unchanged")
  for (const f of [PUC, DL, ALERTS, ENFORCE]) await refused(db, sql[f], /already applied/, `${f}: a second run stops`)

  /* ---------------------------------------------------------------- 4. between the stages: the apps */
  {
    const st = await database(PUC)
    await seed(st)
    for (const f of [PUC, DL, ALERTS]) await st.exec(sql[f])
    // After stage 1, the previous app (no history rows) keeps working — even an expiry date inside its warning period.
    await st.exec(insuranceSave("2026-11-25", ahead(2), "previous", false))
    await st.exec(insuranceSave(ahead(2), ahead(400), "previous", false))
    assert.deepEqual([await insurance(st), (await run(st, `select count(*)::int as n from core.vehicle_document_alerts`))[0].n], [ahead(400), 0], "stage 1: the previous app's alerting-date save is NOT refused")
    // The new app deployed: its saves write their rows; 22 is all OK (the previous app's saves are not counted).
    await st.exec(insuranceSave(ahead(400), ahead(5), "new", false)) // into its window: nothing resolved
    await st.exec(insuranceSave(ahead(5), ahead(365), "new", true))
    assert.deepEqual(await stops(st, activation), [], "22: the new app's saves have their rows — every CHECK OK")
    assert.match((await run(st, activation)).find((r) => Number(r.check_no) === 4)!.actual, /^2 · 1 · 1$/, "22: two new-app saves, one alert resolved, one row")
    // A deployed app that failed to write a row is caught before activation.
    {
      const bad = await database(PUC)
      await seed(bad)
      for (const f of [PUC, DL, ALERTS]) await bad.exec(sql[f])
      await bad.exec(insuranceSave("2026-11-25", ahead(300), "previous", false))
      await bad.exec(insuranceSave(ahead(300), ahead(4), "new", false))
      await bad.exec(insuranceSave(ahead(4), ahead(365), "new", false))
      assert.deepEqual(await stopNos(bad, activation), ["5"], "22: a resolved alert without its row → STOP row 5")
      assert.match((await run(bad, activation)).find((r) => Number(r.check_no) === 7)!.actual, new RegExp(`^missing veh_1 Insurance ${ahead(4)} → ${ahead(365)} \\(\\d+\\)$`), "…and row 7 names it")
    }
    // Stage 4: the previous app's kind of save is refused (nothing saved); the new app's is accepted.
    await st.exec(sql[ENFORCE])
    await st.exec(insuranceSave(ahead(365), ahead(6), "new", false))
    await refused(st, insuranceSave(ahead(6), ahead(500), "previous", false), /must record exactly/, "stage 4: an alerting-date save without its row is refused")
    assert.equal(await insurance(st), ahead(6), "…nothing saved")
    await st.exec(insuranceSave(ahead(6), ahead(500), "new", true))
    assert.equal(await insurance(st), ahead(500), "stage 4: the new app's save (with its row) is accepted")
    assert.deepEqual(await stops(st, activation).then((s) => s.map((r) => r.split(" ")[0])), ["2"], "22 after stage 4: still no difference (row 2 now says applied)")
  }

  /* ---------------------------------------------------------------- 5. rollback, newest first */
  await refused(db, ROLLBACK[1][1], /depends on|cannot drop/, "rolling back 20261122000000 with stage 4 still applied is refused")
  assert.match(await objects(db), /vehicles_document_alerts/, "…and changes nothing")
  for (const [, rb] of ROLLBACK) await db.exec(rb)
  assert.equal(await objects(db), "", "rollback: every new object gone")
  assert.equal((await run(db, fingerprint))[0].f, data0, "…the data as before")
  assert.deepEqual(await stops(db, preflight), [], "…and the pre-flight OK again")

  console.log("vehicle documents deploy: four reviewed migrations, ordering guards, the four-stage deployment (previous app unaffected until stage 4, new app verified by 22, enforcement by 23), data unchanged, documented rollback: all checks passed")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
