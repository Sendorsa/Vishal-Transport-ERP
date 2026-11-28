/**
 * Phase 2B — Expense on the shared database:  npm run check:expense-db
 * docs/PHASE_2B_IMPLEMENTATION_PLAN.md (revision 5), tests T-1 … T-9. The real `api.*` through the real server engine on
 * PostgreSQL (PGlite) with every migration, as Dev, Owner and Employee — RLS, triggers and deferred checks apply; raw SQL
 * as `authenticated` (RLS) and as the database superuser (RLS bypassed) where the plan says so. Never touches a real
 * project. PGlite is PostgreSQL 18.6 and one connection; Production is 17.11 — EXPENSE_DB_PG_DIR runs it on a local
 * PostgreSQL 17 (T-1.5). Also: rollback scripts 08 (F4) and 09 (F1), reset 05 Part B keeping Expense history (F3).
 */
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { PGlite } from "@electric-sql/pglite"
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist"
import type { RequestIdentity } from "@/lib/request-scope"
import type { Expense } from "@/lib/types"

const U = { DEV: "00000000-0000-0000-0000-0000000000e1", OWNER: "00000000-0000-0000-0000-0000000000e2", EMP: "00000000-0000-0000-0000-0000000000e3" }
const P = { DEV: "10000000-0000-0000-0000-0000000000e1", OWNER: "10000000-0000-0000-0000-0000000000e2", EMP: "10000000-0000-0000-0000-0000000000e3" }
const MIG = new URL("../../../../supabase/migrations/", import.meta.url)
const SCRIPTS = new URL("../../../../supabase/scripts/", import.meta.url)
const RO = new URL("../../../../supabase/scripts/production-readonly/", import.meta.url)

/**
 * The database: PGlite by default; or, with EXPENSE_DB_PG_DIR = the data directory of a LOCAL throwaway PostgreSQL server
 * that listens only on its Unix socket (.s.PGSQL.54317 in that directory — no host, no network), a new database on that
 * server per call, through the production driver (Postgres.js with the production type options), one session each — as
 * PGlite. Used for the PostgreSQL 17 run (Production's major version); never a real project.
 */
const PG_DIR = process.env.EXPENSE_DB_PG_DIR
type Db = {
  exec: (text: string) => Promise<{ rows: unknown[] }[]>
  transaction: <T>(fn: (tx: { query: (t: string, p?: unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<T>) => Promise<T>
  close: () => Promise<void>
}
let dbNo = 0
async function newDb(): Promise<Db> {
  if (!PG_DIR) return new PGlite({ extensions: { btree_gist } }) as unknown as Db
  const { default: postgres } = await import("postgres")
  const { PG_TYPES } = await import("./pg-options")
  const opts = { path: ".s.PGSQL.54317", user: "postgres", prepare: false, onnotice: () => undefined, types: PG_TYPES }
  const admin = postgres({ ...opts, database: "postgres", max: 1 })
  const name = `expense_check_${process.pid}_${++dbNo}`
  await admin.unsafe(`create database ${name}`)
  await admin.end()
  const sql = postgres({ ...opts, database: name, max: 1 })
  return {
    exec: async (text) => {
      const r = (await sql.unsafe(text).simple()) as unknown as unknown[]
      return (r.length && Array.isArray(r[0]) ? (r as unknown[][]) : [r]).map((rows) => ({ rows: Array.from(rows as unknown[]) })) // plain arrays, as PGlite
    },
    transaction: (fn) => sql.begin((tx) => fn({ query: async (t, p) => ({ rows: Array.from((await tx.unsafe(t, (p ?? []) as never[])) as unknown[]) }) })) as never,
    close: () => sql.end(),
  }
}

async function freshDb(upTo: (f: string) => boolean) {
  const db = await newDb()
  await db.exec(`
    do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
    do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
    do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;
    create schema auth;
    create table auth.users (id uuid primary key, email text);
    create table auth.identities (id uuid primary key default gen_random_uuid(), user_id uuid references auth.users (id), provider text, identity_data jsonb, created_at timestamptz default now());
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  `)
  for (const f of readdirSync(MIG).filter((f) => f.endsWith(".sql") && upTo(f)).sort()) await db.exec(readFileSync(new URL(f, MIG), "utf8"))
  return db
}
/** Rows of a check script: every CHECK row must be OK. */
const stops = (rows: { status: string; check_name: string; expected: string; actual: string }[]) => rows.filter((r) => r.status === "STOP").map((r) => `${r.check_name}: expected ${r.expected}, got ${r.actual}`)

async function main() {
  if (PG_DIR) process.chdir(PG_DIR) // the socket's path is relative (macOS limits socket paths to ~103 characters)
  const { runInDatabase, changesSince } = await import("./engine")
  const { api, ConflictError, PossibleDuplicateError } = await import("@/lib/api")
  const { todayISO } = await import("@/lib/format")
  const { blankExpense, brokerOutstanding } = await import("@/domain/expenses")

  /* ---------------------------------------------------------------- T-1.1 / T-1.3 the migration, its preflight and post-apply */
  // Order: …20261121 → 24 preflight → 20261127 (Driver master) → 25 post-apply → 27 preflight → 20261128 (Expense) → 28.
  const db = await freshDb((f) => f < "20261127")
  const run = async (sql: string) => (await db.exec(sql)).at(-1)!.rows as never[]
  const driverMigration = readFileSync(new URL("20261127000000_driver_master_company_periods.sql", MIG), "utf8")
  const migration = readFileSync(new URL("20261128000000_expense_schema.sql", MIG), "utf8")
  assert.ok(stops(await run(readFileSync(new URL("27-expense-preflight.sql", RO), "utf8"))).some((x) => x.startsWith("driver master migration")), "27 says STOP while the Driver migration is missing")
  await assert.rejects(db.exec(migration), /apply every migration up to 20261127000000/, "the Expense migration refuses to run before the Driver migration")
  await db.exec("rollback")
  assert.deepEqual(stops(await run(readFileSync(new URL("24-driver-master-preflight.sql", RO), "utf8"))), [], "24 preflight: every CHECK OK before the Driver migration")
  await db.exec(driverMigration)
  assert.deepEqual(stops(await run(readFileSync(new URL("25-driver-master-post-apply.sql", RO), "utf8"))), [], "25 post-apply: every CHECK OK")
  await assert.rejects(db.exec(driverMigration), /already applied/, "a second Driver migration run stops")
  await db.exec("rollback")
  assert.deepEqual(stops(await run(readFileSync(new URL("27-expense-preflight.sql", RO), "utf8"))), [], "27 preflight: every CHECK OK before the migration")
  await db.exec(migration)
  assert.deepEqual(stops(await run(readFileSync(new URL("28-expense-post-apply.sql", RO), "utf8"))), [], "28 post-apply: every CHECK OK")
  await assert.rejects(db.exec(migration), /already exists \(applied fully or partly\)/, "a second run stops")
  await db.exec("rollback") // the file opens its own transaction; its guard aborted it
  assert.equal(((await run(`select count(*)::int n from information_schema.tables where table_schema = 'expense'`))[0] as { n: number }).n, 6, "…with nothing changed")
  // (Row "database" expects Supabase's database name, postgres; each local-server run uses its own test database.)
  assert.deepEqual(stops(await run(readFileSync(new URL("10-adblue-vendors-post-apply.sql", RO), "utf8"))).filter((x) => !(PG_DIR && x.startsWith("database: expected postgres"))), [], "10: every deletable table classified (expense.entries owner/dev, entry_vehicles owner/dev + audited edit)")
  /** Everything a migration or a rollback can change: functions, policies, schemas, types, tables, columns (with comments), constraints, indexes, triggers. */
  const dbState = async (q: (sql: string) => Promise<never[]>) => JSON.stringify({
    fns: await q(`select p.oid::regprocedure::text f, md5(p.prosrc) m from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname not in ('pg_catalog', 'information_schema') order by 1`),
    policies: await q(`select schemaname, tablename, policyname, cmd, qual, with_check from pg_policies order by 1, 2, 3`),
    schemas: await q(`select nspname from pg_namespace order by 1`),
    types: await q(`select t.oid::regtype::text t from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast') order by 1`),
    tables: await q(`select schemaname, tablename from pg_tables where schemaname not in ('pg_catalog', 'information_schema') order by 1, 2`),
    columns: await q(`select c.table_schema, c.table_name, c.column_name, c.is_nullable, c.data_type, coalesce(col_description(format('%I.%I', c.table_schema, c.table_name)::regclass, c.ordinal_position), '') d
      from information_schema.columns c join pg_tables t on t.schemaname = c.table_schema and t.tablename = c.table_name where c.table_schema not in ('pg_catalog', 'information_schema') order by 1, 2, 3`),
    constraints: await q(`select conrelid::regclass::text r, conname, pg_get_constraintdef(oid) d from pg_constraint where connamespace not in ('pg_catalog'::regnamespace, 'information_schema'::regnamespace) and conrelid <> 0 order by 1, 2`),
    indexes: await q(`select schemaname, indexname, indexdef from pg_indexes where schemaname not in ('pg_catalog', 'information_schema') order by 1, 2`),
    triggers: await q(`select tgrelid::regclass::text r, tgname from pg_trigger where not tgisinternal order by 1, 2`),
  })
  {
    // T-1.2 rollback, on a separate database: 08-rollback-expense-schema.sql leaves exactly the state before the migration,
    // the migration then applies again; 08 refuses (changing nothing) once Expense has any audit event or any data (F4).
    const rdb = await freshDb((f) => f < "20261128")
    const rrun = async (sql: string) => (await rdb.exec(sql)).at(-1)?.rows as never[]
    const one = async (sql: string) => ((await rrun(sql))[0] as { n: number }).n
    const s0 = await dbState(rrun)
    const rollback = readFileSync(new URL("08-rollback-expense-schema.sql", SCRIPTS), "utf8")
    await rdb.exec(migration)
    assert.equal(await one(`select count(*)::int n from audit.events where module = 'Expense'`), 0)
    await rdb.exec(rollback)
    assert.equal(await dbState(rrun), s0, "T-1.2 / F4(a) empty Expense tables and no Expense audit event: 08 runs — the database exactly as before the migration")
    await rdb.exec(migration) // applies again unchanged
    assert.deepEqual(stops(await rrun(readFileSync(new URL("28-expense-post-apply.sql", RO), "utf8"))), [], "…and 28 passes after re-applying")
    const s1 = await dbState(rrun)
    // F4(b): an entry created and deleted — every table empty again, but its CREATED / DELETED events stay.
    await rdb.exec(`insert into audit.events (actor_kind, action, module, record_type, record_id) values ('SYSTEM', 'CREATED', 'Expense', 'Broker bill', 'exp_rb0000000001');
      insert into expense.entries (id, section, date, entry_type, broker_name, description, amount) values ('exp_rb0000000001', 'BROKER', '2026-09-01', 'CHARGE', 'Gone Broker', 'bill', 10)`)
    await rdb.exec(`insert into audit.events (actor_kind, action, module, record_type, record_id, reason) values ('SYSTEM', 'DELETED', 'Expense', 'Broker bill', 'exp_rb0000000001', 'Entered by mistake');
      delete from expense.entries where id = 'exp_rb0000000001'`)
    assert.equal(await one(`select ((select count(*) from expense.entries) + (select count(*) from expense.entry_vehicles) + (select count(*) from expense.brokers) + (select count(*) from expense.month_locks) + (select count(*) from expense.import_batches) + (select count(*) from expense.import_items))::int n`), 0, "every Expense table empty")
    await assert.rejects(rdb.exec(rollback), /audit trail holds 2 Expense event\(s\)/, "F4(b) empty tables but Expense audit events: 08 refuses")
    await rdb.exec("rollback").catch(() => undefined)
    assert.equal(await dbState(rrun), s1, "…before changing anything (schema, functions, policies exactly as applied)")
    // F4(c): data present (the data check comes first, as before).
    await rdb.exec(`insert into audit.events (actor_kind, action, module, record_type, record_id) values ('SYSTEM', 'CREATED', 'Expense', 'Broker', 'brk_rb0000000001');
      insert into expense.brokers (id, name) values ('brk_rb0000000001', 'Kept')`)
    await assert.rejects(rdb.exec(rollback), /Expense holds data/, "F4(c) Expense data present: 08 refuses")
    await rdb.exec("rollback").catch(() => undefined)
    assert.equal(await one(`select count(*)::int n from expense.brokers`), 1, "…and changes nothing")
    await rdb.close()
  }
  {
    // F1 Driver rollback, on a separate database: 09-rollback-driver-master.sql returns exactly the state before
    // 20261127000000 (24 OK again; the migration applies again), and refuses — changing nothing — while the additions hold
    // data: a dated vehicle company, a father's name / date of birth / address, a driver without a company.
    const ddb = await freshDb((f) => f < "20261127")
    const drun = async (sql: string) => (await ddb.exec(sql)).at(-1)?.rows as never[]
    const rollback09 = readFileSync(new URL("09-rollback-driver-master.sql", SCRIPTS), "utf8")
    await ddb.exec(`insert into audit.events (actor_kind, action, module, record_type, record_id) values ('SYSTEM', 'CREATED', 'Drivers', 'Driver', 'drv_rb0000000001');
      insert into core.drivers (id, name, company_code) values ('drv_rb0000000001', 'Existing Driver', 'VTHPL');
      insert into audit.events (actor_kind, action, module, record_type, record_id) values ('SYSTEM', 'CREATED', 'Vehicles', 'Vehicle', 'veh_rb0000000001');
      insert into core.vehicles (id, reg_no, company_code, type_code, fuel_type) values ('veh_rb0000000001', 'TN70RB0001', 'VTHPL', 'BUS_55', 'DIESEL')`)
    const driverRows = `select id, name, phone, company_code, status from core.drivers order by id`
    const d0 = JSON.stringify(await drun(driverRows))
    await assert.rejects(ddb.exec(rollback09), /not \(fully\) applied/, "09 before the migration: refused")
    await ddb.exec("rollback").catch(() => undefined)
    const s0 = await dbState(drun)
    await ddb.exec(driverMigration)
    await ddb.exec(rollback09)
    assert.equal(await dbState(drun), s0, "F1 09 with no new data: the database exactly as before 20261127000000 (tables, columns, comments, constraints, functions, policies, triggers)")
    assert.equal(JSON.stringify(await drun(driverRows)), d0, "…the existing driver unchanged (no backfill, no data change)")
    assert.deepEqual(stops(await drun(readFileSync(new URL("24-driver-master-preflight.sql", RO), "utf8"))), [], "…24 preflight OK again")
    await ddb.exec(driverMigration)
    assert.deepEqual(stops(await drun(readFileSync(new URL("25-driver-master-post-apply.sql", RO), "utf8"))), [], "…the migration applies again; 25 OK")
    const s1 = await dbState(drun)
    const refusedBy = async (setup: string, undo: string, why: RegExp, msg: string) => {
      await ddb.exec(setup)
      const before = JSON.stringify(await drun(`select to_jsonb(d) j from core.drivers d order by id`)) + JSON.stringify(await drun(`select to_jsonb(p) - 'updated_at' j from core.vehicle_company_periods p order by id`))
      await assert.rejects(ddb.exec(rollback09), why, msg)
      await ddb.exec("rollback").catch(() => undefined)
      assert.equal(await dbState(drun), s1, `${msg}: nothing changed in the schema`)
      assert.equal(JSON.stringify(await drun(`select to_jsonb(d) j from core.drivers d order by id`)) + JSON.stringify(await drun(`select to_jsonb(p) - 'updated_at' j from core.vehicle_company_periods p order by id`)), before, `${msg}: no row changed`)
      await ddb.exec(undo)
    }
    const evD = (action: string) => `insert into audit.events (actor_kind, action, module, record_type, record_id) values ('SYSTEM', '${action}', 'Drivers', 'Driver', 'drv_rb0000000001');`
    const evV = `insert into audit.events (actor_kind, action, module, record_type, record_id) values ('SYSTEM', 'UPDATED', 'Vehicles', 'Vehicle', 'veh_rb0000000001');`
    await refusedBy(`${evV} insert into core.vehicle_company_periods (id, vehicle_id, company_code, start_date, end_date) values ('vcp_rb0000000001', 'veh_rb0000000001', 'VTHPL', '2026-01-01', '2026-10-31')`,
      `${evV} delete from core.vehicle_company_periods`, /vehicle_company_periods holds 1 row/, "F1(a) a dated vehicle company")
    for (const [col, val] of [["father_name", "'Raman'"], ["date_of_birth", "'1985-04-02'"], ["address", "'Hosur'"]] as const)
      await refusedBy(`${evD("UPDATED")} update core.drivers set ${col} = ${val} where id = 'drv_rb0000000001'`,
        `${evD("UPDATED")} update core.drivers set ${col} = ${col === "date_of_birth" ? "null" : "''"} where id = 'drv_rb0000000001'`, /1 driver\(s\) have a father's name, date of birth or address/, `F1(b) a recorded ${col}`)
    await refusedBy(`${evD("CREATED").replace("drv_rb0000000001", "drv_rb0000000002")} insert into core.drivers (id, name, company_code) values ('drv_rb0000000002', 'New Driver', null)`,
      `${evD("DELETED").replace("drv_rb0000000001", "drv_rb0000000002")} delete from core.drivers where id = 'drv_rb0000000002'`, /1 driver\(s\) have no company_code/, "F1(c) a driver without a company")
    await ddb.exec(rollback09) // every addition empty again: allowed
    assert.equal(await dbState(drun), s0, "…once nothing would be lost, 09 runs and restores the earlier state")
    await ddb.close()
  }

  /* ---------------------------------------------------------------- accounts, masters */
  await db.exec(`
    insert into auth.users values ('${U.DEV}', 'dev@example.com'), ('${U.OWNER}', 'owner@example.com'), ('${U.EMP}', 'staff@example.com');
    insert into public.profiles (id, user_id, email, full_name, role, status, activated_at) values
      ('${P.DEV}', '${U.DEV}', 'dev@example.com', 'Dev Person', 'DEV', 'ACTIVE', now()),
      ('${P.OWNER}', '${U.OWNER}', 'owner@example.com', 'Owner Person', 'OWNER', 'ACTIVE', now()),
      ('${P.EMP}', '${U.EMP}', 'staff@example.com', null, 'EMPLOYEE', 'ACTIVE', now());
    insert into audit.events (actor_kind, action, module, record_type, record_id) values
      ('SYSTEM', 'CREATED', 'Accounts', 'User account', '${P.DEV}'), ('SYSTEM', 'CREATED', 'Accounts', 'User account', '${P.OWNER}'), ('SYSTEM', 'CREATED', 'Accounts', 'User account', '${P.EMP}');
  `)
  const transact = <T,>(fn: (sql: (t: string, p?: unknown[]) => Promise<never[]>) => Promise<T>) => db.transaction(async (tx) => fn(async (text, params) => (await tx.query(text, params ?? [])).rows as never[]))
  const who = (k: keyof typeof U, role: RequestIdentity["role"], name: string | null): RequestIdentity => ({ profileId: P[k], userId: U[k], role, email: `${k.toLowerCase()}@example.com`, name })
  const DEV = who("DEV", "DEV", "Dev Person")
  const OWNER = who("OWNER", "OWNER", "Owner Person")
  const EMP = who("EMP", "EMPLOYEE", null)
  const as = <T,>(id: RequestIdentity, call: () => Promise<T>, write = true, expected: Record<string, string> = {}) => runInDatabase(transact as never, id, write, expected, call)
  const read = <T,>(id: RequestIdentity, call: () => Promise<T>) => as(id, call, false)
  /** Raw SQL in one transaction: as `authenticated` with the account's claims (RLS), or as the superuser (`id` null). */
  const sqlAs = async (id: RequestIdentity | null, text: string) => {
    await db.exec("begin")
    try {
      if (id) await db.exec(`set local role authenticated; select set_config('request.jwt.claim.sub', '${id.userId}', true);`)
      const r = (await db.exec(text)).at(-1)?.rows
      await db.exec("commit")
      return r as never[]
    } catch (e) {
      await db.exec("rollback").catch(() => undefined)
      throw e
    }
  }
  const today = todayISO()
  const sep = "2026-09"

  const minda = await as(OWNER, () =>
    api.customers.create({ code: "MINDA", shortName: "Minda", name: "Minda Industries", legalName: "Minda Industries Ltd", companyCode: "VT", businessUnit: "STAFF_BUS", gstin: "", state: "Tamil Nadu", stateCode: "33", city: "Hosur", contactName: "", phone: "", email: "", creditDays: 30, pricing: { model: "PER_TRIP", rate: 1500, includedKm: 0, extraKmRate: 0, driverBata: 0, routes: [] }, status: "ACTIVE", notes: "" })
  )
  const veh = (regNo: string) =>
    as(OWNER, () => api.vehicles.create({ regNo, companyCode: "VTHPL", typeCode: "BUS_55", make: "", model: "", year: 0, seats: 55, fuelType: "DIESEL", mileageKmpl: 4.3, ownership: "OWNED", ownerName: null, status: "ACTIVE", odometerKm: 0, assignedCustomerId: minda.id, defaultDriverId: null, insurance: { provider: "", policyNo: "", validTill: "", premium: 0 }, roadTax: { validTill: "", amount: 0, period: "ANNUAL" }, fitnessValidTill: "", permitValidTill: "", emiAmount: 0, notes: "", assignedSince: "2026-08-01" } as never))
  const v1 = await veh("TN70AK1869")
  const v2 = await veh("TN70AV2412")
  const v3 = await veh("TN70AX8509")
  const drv = await as(OWNER, () => api.drivers.create({ name: "Ravi Kumar", phone: "", licenseNo: "", licenseValidTill: "", companyCode: null, status: "ACTIVE" }))

  /* ---------------------------------------------------------------- Driver master and dated vehicle company (20261127000000) */
  {
    const d2 = await as(EMP, () => api.drivers.create({ name: "Mani", fatherName: "Raman", dateOfBirth: "1985-04-02", address: "Hosur", phone: "", licenseNo: "TN70 20110001234", licenseValidTill: "", companyCode: null, status: "ACTIVE" }))
    const dBack = (await read(DEV, () => api.drivers.list())).find((d) => d.id === d2.id)!
    assert.deepEqual([dBack.fatherName, dBack.dateOfBirth, dBack.address, dBack.companyCode ?? null], ["Raman", "1985-04-02", "Hosur", null], "D-1 the new driver columns round trip; no company recorded")
    const v4 = await veh("TN70DR0001")
    const v4now = (await read(DEV, () => api.vehicles.list())).find((v) => v.id === v4.id)!
    await as(EMP, () => api.vehicles.changeCompany(v4.id, "VT", "2026-11-01"), true, { [v4.id]: v4now.updatedAt })
    const periods = async () => (await sqlAs(null, `select company_code c, start_date::text s, end_date::text e from core.vehicle_company_periods where vehicle_id = '${v4.id}' order by start_date`)) as { c: string; s: string; e: string | null }[]
    assert.deepEqual((await periods()).map((p) => [p.c, p.e]), [["VTHPL", "2026-10-31"], ["VT", null]], "D-2 the Employee's company change: the old company closed the day before, the new one open")
    assert.deepEqual((await read(DEV, () => api.vehicles.list())).find((v) => v.id === v4.id)!.companyPeriods!.map((p) => [p.companyCode, p.endDate]), [["VTHPL", "2026-10-31"], ["VT", null]], "…read back through the engine")
    assert.equal(((await sqlAs(null, `select count(*)::int n from audit.events where record_id = '${v4.id}' and action = 'UPDATED' and after ? 'companyPeriods'`))[0] as { n: number }).n, 1, "…one audited vehicle edit")
    const v4b = (await read(DEV, () => api.vehicles.list())).find((v) => v.id === v4.id)!
    await assert.rejects(as(EMP, () => api.vehicles.changeCompany(v4.id, "VTHPL", "2026-10-15"), true, { [v4.id]: v4b.updatedAt }), /last changed on 01-11-2026/, "D-3 never before the last change")
    await assert.rejects(as(EMP, () => api.vehicles.changeCompany(v4.id, "VTHPL", "2099-01-01"), true, { [v4.id]: v4b.updatedAt }), /future/, "D-4 never in the future")
    const ev4 = `insert into audit.events (actor_kind, action, module, record_type, record_id) values ('SYSTEM', 'UPDATED', 'Vehicles', 'Vehicle', '${v4.id}');`
    await assert.rejects(sqlAs(null, `${ev4} insert into core.vehicle_company_periods (vehicle_id, company_code, start_date, end_date) values ('${v4.id}', 'VT', '2026-10-31', '2026-11-05')`), /vehicle_company_periods_no_overlap|conflicting key/, "D-5 overlapping periods refused (exclusion constraint, btree_gist)")
    await assert.rejects(sqlAs(null, `insert into core.vehicle_company_periods (vehicle_id, company_code, start_date, end_date) values ('${v1.id}', 'VT', '2025-01-01', '2025-01-31')`), /audit/i, "D-6 no period without its vehicle's audit event")
    await assert.rejects(sqlAs(EMP, `delete from core.vehicle_company_periods where vehicle_id = '${v4.id}'`), /Only the Owner and Dev can delete records|audit/i, "D-7 the Employee can't delete history outside an audited edit")
    assert.equal((await periods()).length, 2, "…nothing changed")
  }
  const base = (section: Expense["section"], x: Partial<Expense> = {}) => ({ ...blankExpense(section, today), ...x })
  const rt = (x: Partial<Expense> = {}) => base("ROAD_TAX", { vehicleIds: [v1.id], description: "MV TAX", taxType: "Same state", amount: 30300, companyCode: "VT", ...x })
  const rid = () => crypto.randomUUID()
  const expenses = () => read(DEV, () => api.expenses.list())
  /** The same stored record (the database returns timestamps as +00:00 text where the app wrote Z). */
  const sameRecord = (a: Expense, b: Expense, msg: string) => assert.deepEqual([a.id, Date.parse(a.createdAt), a.amount, a.paidAmount], [b.id, Date.parse(b.createdAt), b.amount, b.paidAmount], msg)

  /* ---------------------------------------------------------------- T-2 engine persistence (parent + ordered children) */
  const r1 = await as(DEV, () => api.expenses.create(rt({ requestId: rid() })))
  const ev = async (id: string) => (await sqlAs(null, `select line_no, vehicle_id from expense.entry_vehicles where entry_id = '${id}' order by line_no`)) as { line_no: number; vehicle_id: string }[]
  assert.deepEqual((await ev(r1.id)).map((r) => r.vehicle_id), [v1.id], "T-2.1 one entry row + one vehicle line")
  await as(DEV, () => api.brokers.create("ABC Bunk Broker"))
  const bill = await as(DEV, () => api.expenses.create(base("BROKER", { entryType: "CHARGE", broker: "ABC Bunk Broker", billNo: "001", description: "Bunk bill 001", amount: 10000, vehicleIds: [v3.id, v1.id, v2.id], date: "2026-09-05", requestId: rid() })))
  assert.deepEqual((await ev(bill.id)).map((r) => [r.line_no, r.vehicle_id]), [[0, v3.id], [1, v1.id], [2, v2.id]], "T-2.2 order kept")
  assert.deepEqual((await expenses()).find((x) => x.id === bill.id)!.vehicleIds, [v3.id, v1.id, v2.id], "…and read back in order")
  const brokerRow = (await sqlAs(null, `select broker_id from expense.entries where id = '${bill.id}'`))[0] as { broker_id: string }
  assert.ok(brokerRow.broker_id?.startsWith("brk_"), "broker_id linked from the broker name")
  // T-2.3 an edit of the vehicles only bumps the version; a stale edit is refused.
  const r1Now = (await expenses()).find((x) => x.id === r1.id)!
  const r1e = await as(DEV, () => api.expenses.update(r1.id, { ...r1Now, vehicleIds: [v2.id] }), true, { [r1.id]: r1Now.updatedAt })
  const r1Db = (await expenses()).find((x) => x.id === r1.id)!
  assert.notEqual(r1Db.updatedAt, r1Now.updatedAt, "T-2.3 updated_at changes when only the vehicles change")
  assert.deepEqual((await ev(r1.id)).map((r) => r.vehicle_id), [v2.id])
  await assert.rejects(as(DEV, () => api.expenses.update(r1.id, { ...r1Now, remarks: "stale" }), true, { [r1.id]: r1Now.updatedAt }), (e) => e instanceof ConflictError, "a stale version is refused")
  void r1e
  // T-2.4 failure injection: a deferred guard failing at COMMIT leaves nothing (overpayment).
  const countAll = async () => ((await sqlAs(null, `select (select count(*) from expense.entries)::int e, (select count(*) from expense.entry_vehicles)::int v, (select count(*) from audit.events where module = 'Expense')::int a`))[0] as { e: number; v: number; a: number })
  const c0 = await countAll()
  await assert.rejects(sqlAs(DEV, `insert into audit.events (actor_kind, actor_user_id, actor_role, action, module, record_type, record_id) values ('SESSION', '${P.DEV}', 'DEV', 'CREATED', 'Expense', 'Broker payment', 'exp_inject000001');
    insert into expense.entries (id, section, date, entry_type, broker_name, paid_amount) values ('exp_inject000001', 'BROKER', '2026-09-06', 'PAYMENT', 'ABC Bunk Broker', 10000.01);`), /more than billed/, "T-2.4 / T-9 ledger guard at COMMIT (raw SQL, API bypassed)")
  assert.deepEqual(await countAll(), c0, "…nothing written, no audit event")
  // T-2.5 delete: parent and its vehicle lines together; DELETED event with reason.
  const tmp = await as(DEV, () => api.expenses.create(base("BROKER", { entryType: "CHARGE", broker: "ABC Bunk Broker", description: "temp", amount: 50, vehicleIds: [v1.id, v2.id], date: "2026-09-07" })))
  await as(DEV, () => api.expenses.remove(tmp.id, "Entered by mistake"))
  assert.deepEqual(await ev(tmp.id), [], "T-1.7 / T-2.5 unlocked parent delete cascades to every vehicle line")
  assert.equal(((await sqlAs(null, `select count(*)::int n from audit.events where record_id = '${tmp.id}' and action = 'DELETED' and reason = 'Entered by mistake'`))[0] as { n: number }).n, 1)

  /* ---------------------------------------------------------------- T-4 idempotency and the broker-payment confirmation */
  const k1 = rid()
  const once = await as(DEV, () => api.expenses.create(rt({ amount: 1111, requestId: k1 })))
  for (let i = 0; i < 2; i++) sameRecord(await as(DEV, () => api.expenses.create(rt({ amount: 1111, requestId: k1 }))), once, "T-4.1 same request id: the same row")
  assert.equal((await expenses()).filter((x) => x.requestId === k1).length, 1)
  assert.equal(((await sqlAs(null, `select count(*)::int n from audit.events where record_id = '${once.id}'`))[0] as { n: number }).n, 1, "…one CREATED event")
  await assert.rejects(as(DEV, () => api.expenses.create(rt({ amount: 2222, requestId: k1 }))), /already saved with different values/, "T-4.2 changed contents refused")
  assert.equal((await expenses()).find((x) => x.id === once.id)!.amount, 1111)
  const k3 = rid()
  await Promise.allSettled([as(DEV, () => api.expenses.create(rt({ amount: 3333, requestId: k3 }))), as(DEV, () => api.expenses.create(rt({ amount: 3333, requestId: k3 })))])
  assert.equal((await expenses()).filter((x) => x.requestId === k3).length, 1, "T-4.3 two simultaneous calls: one row")
  await assert.rejects(sqlAs(null, `begin; insert into audit.events (actor_kind, action, module, record_type, record_id) values ('SYSTEM', 'CREATED', 'Expense', 'Road tax', 'exp_dupkey000001');
    insert into expense.entries (id, section, date, company_code, description, amount, request_id) values ('exp_dupkey000001', 'ROAD_TAX', '${today}', 'VT', 'MV TAX', 1, '${k3}');`), /duplicate key/, "…the unique key backs it up (lock bypassed)")
  const pay = (x: Partial<Expense>) => base("BROKER", { entryType: "PAYMENT", broker: "ABC Bunk Broker", paidAmount: 3000, date: "2026-10-10", paymentDate: "2026-10-10", ...x })
  await as(DEV, () => api.expenses.create(pay({ requestId: rid() })))
  const k4 = rid()
  await assert.rejects(as(DEV, () => api.expenses.create(pay({ requestId: k4 }))), (e) => e instanceof PossibleDuplicateError, "T-4.4 identical payment → confirmation, nothing written")
  const confirmed = await as(DEV, () => api.expenses.create(pay({ requestId: k4 }), { confirmSameDay: true }))
  sameRecord(await as(DEV, () => api.expenses.create(pay({ requestId: k4 }), { confirmSameDay: true })), confirmed, "…the confirmed call retried returns the saved payment")
  const sameDay = (await expenses()).filter((x) => x.entryType === "PAYMENT" && x.date === "2026-10-10" && x.paidAmount === 3000)
  assert.equal(sameDay.length, 2, "T-4.5 two genuine identical payments")
  assert.equal(brokerOutstanding(await expenses(), "ABC Bunk Broker"), 4000, "…outstanding reduced twice (10,000 − 3,000 − 3,000)")
  sameRecord(await as(DEV, () => api.expenses.create(pay({ requestId: k4 }), { confirmSameDay: true })), confirmed, "T-4.6 a consumed key never makes a second row")
  await assert.rejects(as(DEV, () => api.expenses.create(pay({ paidAmount: 999, requestId: k4 }), { confirmSameDay: true })), /already saved with different values/)
  await as(DEV, () => api.expenses.create(pay({ paidAmount: 3000, date: "2026-10-11", paymentDate: "2026-10-11", requestId: rid() })))
  assert.equal(brokerOutstanding(await expenses(), "ABC Bunk Broker"), 1000, "T-4.7 another date: no confirmation")
  await assert.rejects(as(DEV, () => api.expenses.create(pay({ paidAmount: 3000, date: "2026-10-11", paymentDate: "2026-10-11", requestId: rid() }), { confirmSameDay: true })), /a payment can't be more than that/, "T-4.8 confirmed but overpaying: refused")
  for (const x of [rt({ requestId: rid() }), rt({ requestId: rid() })]) await as(DEV, () => api.expenses.create(x))
  await as(DEV, () => api.expenses.create(base("BROKER", { entryType: "CHARGE", broker: "ABC Bunk Broker", billNo: "", description: "Same bill text", amount: 70, date: "2026-10-12", requestId: rid() })))
  await as(DEV, () => api.expenses.create(base("BROKER", { entryType: "CHARGE", broker: "ABC Bunk Broker", billNo: "", description: "Same bill text", amount: 70, date: "2026-10-12", requestId: rid() })))
  await assert.rejects(as(DEV, () => api.expenses.create(base("BROKER", { entryType: "CHARGE", broker: "ABC Bunk Broker", billNo: " 001 ", description: "x", amount: 70, date: "2026-10-12", requestId: rid() }))), /Bill 001 of ABC Bunk Broker is already recorded/, "T-4.9 no popup for Road Tax / bills; bill numbers still unique")

  /* ---------------------------------------------------------------- Fines: Payment Reference optional (T-6, R5) */
  const fine = await as(DEV, () => api.expenses.create(base("FINE", { vehicleIds: [v1.id], taxType: "Signal jump", amount: 500, paymentStatus: "PAID", paymentDate: today, paymentReference: "", driverId: drv.id, requestId: rid() })))
  assert.equal(fine.paymentReference, "", "a PAID fine without a reference is accepted")
  const unpaid = await as(DEV, () => api.expenses.create(base("FINE", { vehicleIds: [v1.id], taxType: "Overload", amount: 700, paymentStatus: "UNPAID", paymentReference: "CH-1", requestId: rid() })))
  assert.equal(unpaid.paymentReference, "", "an UNPAID fine's reference is stored blank by the API")
  await assert.rejects(sqlAs(null, `insert into audit.events (actor_kind, action, module, record_type, record_id) values ('SYSTEM', 'UPDATED', 'Expense', 'Fine', '${unpaid.id}'); update expense.entries set payment_reference = 'CH-1' where id = '${unpaid.id}';`), /entries_fine/, "…and refused by entries_fine if written directly")

  /* ---------------------------------------------------------------- T-1.4 / T-1.6 / T-1.8 section-month locks: trigger + RLS, cascade-aware */
  const sepRt = await as(DEV, () => api.expenses.create(rt({ date: `${sep}-15`, vehicleIds: [v1.id], requestId: rid() })))
  await as(DEV, () => api.expenseMonths.lock("ROAD_TAX", sep))
  const lockMsg = /September 2026 is locked in Road Tax/
  await assert.rejects(as(DEV, () => api.expenses.create(rt({ date: `${sep}-16`, requestId: rid() }))), lockMsg, "API refuses (Dev too)")
  await assert.rejects(sqlAs(DEV, `insert into expense.entry_vehicles (entry_id, line_no, vehicle_id) values ('${sepRt.id}', 1, '${v2.id}')`), /locked in Road Tax|row-level security/, "T-1.6 child insert under RLS refused")
  for (const stmt of [`insert into expense.entry_vehicles (entry_id, line_no, vehicle_id) values ('${sepRt.id}', 1, '${v2.id}')`, `update expense.entry_vehicles set vehicle_id = '${v2.id}' where entry_id = '${sepRt.id}'`, `delete from expense.entry_vehicles where entry_id = '${sepRt.id}'`,
    `update expense.entries set amount = 1 where id = '${sepRt.id}'`, `delete from expense.entries where id = '${sepRt.id}'`, `insert into expense.entries (id, section, date, company_code, description, amount) values ('exp_locked000001', 'ROAD_TAX', '${sep}-20', 'VT', 'MV TAX', 5)`])
    await assert.rejects(sqlAs(null, `insert into audit.events (actor_kind, action, module, record_type, record_id) values ('SYSTEM', 'UPDATED', 'Expense', 'Road tax', '${sepRt.id}'); ${stmt}`), lockMsg, `T-1.4 / T-1.6 / T-1.8 superuser (RLS bypassed) refused by the trigger: ${stmt.slice(0, 40)}`)
  assert.deepEqual(await ev(sepRt.id), [{ line_no: 0, vehicle_id: v1.id }], "the locked entry and its line are unchanged")
  await assert.rejects(as(DEV, () => api.expenses.remove(sepRt.id, "Try")), lockMsg, "T-1.8 locked parent delete refused")
  await assert.rejects(sqlAs(DEV, `update expense.month_locks set month = '2026-08'`), /permission denied/, "T-1.4 no unlock: no UPDATE grant")
  await assert.rejects(sqlAs(DEV, `delete from expense.month_locks`), /permission denied/, "…no DELETE grant")
  await as(DEV, () => api.expenses.create(base("FITNESS", { vehicleIds: [v1.id], amount: 300, date: `${sep}-15`, requestId: rid() })))
  // T-1.6 open section-month: child operations through an audited edit work.
  const openRt = await as(DEV, () => api.expenses.create(rt({ date: "2026-10-03", requestId: rid() })))
  const openNow = (await expenses()).find((x) => x.id === openRt.id)!
  await as(DEV, () => api.expenses.update(openRt.id, { ...openNow, vehicleIds: [v3.id] }), true, { [openRt.id]: openNow.updatedAt })
  assert.deepEqual((await ev(openRt.id)).map((r) => r.vehicle_id), [v3.id], "an open month's vehicle line replaced")
  // Monthly Sheet Lock alongside: Dev bypasses it (no effect while Dev-only).
  await as(DEV, () => api.monthLocks.set("2026-10", "LOCKED"))
  await as(DEV, () => api.expenses.create(rt({ date: "2026-10-04", requestId: rid() })))

  /* ---------------------------------------------------------------- T-3 Expense audit events never reach Owner / Employee */
  const expEvents = (await sqlAs(null, `select id from audit.events where module = 'Expense'`)) as { id: string }[]
  assert.ok(expEvents.length > 10)
  for (const id of [OWNER, EMP]) {
    assert.equal(((await sqlAs(id, `select count(*)::int n from audit.events where module = 'Expense'`))[0] as { n: number }).n, 0, `T-3.1 ${id.role}: RLS hides Expense events`)
    assert.ok(((await sqlAs(id, `select count(*)::int n from audit.events where module <> 'Expense'`))[0] as { n: number }).n > 0, `T-3.6 ${id.role}: other modules still listed`)
    const list = await read(id, () => api.audit.list())
    assert.equal(list.filter((e) => e.module === "Expense" || /ABC Bunk|MV TAX|Signal jump/.test(e.label)).length, 0, `T-3.2 ${id.role}: no Expense row, label or amount in the Audit Log`)
    assert.deepEqual(await read(id, () => api.audit.history(sepRt.id)), [], `T-3.3 ${id.role}: no record history`)
    assert.ok(!(await read(id, () => api.audit.editedIds())).includes(openRt.id))
    const changes = await changesSince(transact as never, id, new Date(Date.now() - 3600_000).toISOString())
    assert.ok(!changes.modules.includes("Expense"), `T-3.5 ${id.role}: polling never says Expense`)
  }
  const tmpDel = (await sqlAs(null, `select id from audit.events where module = 'Expense' and action = 'DELETED' limit 1`))[0] as { id: string }
  assert.equal(await read(OWNER, () => api.audit.unreviewedDeletions()), 0, "T-3.4 an Expense deletion doesn't raise the Owner's badge")
  await assert.rejects(sqlAs(OWNER, `insert into audit.reviews (event_id, actor_user_id, actor_role) values ('${tmpDel.id}', '${P.OWNER}', 'OWNER')`), /row-level security/, "…nor can the Owner review it")
  assert.ok((await read(DEV, () => api.audit.list())).some((e) => e.module === "Expense"), "Dev sees them")
  assert.ok((await changesSince(transact as never, DEV, new Date(Date.now() - 3600_000).toISOString())).modules.includes("Expense"))
  await assert.rejects(read(OWNER, () => api.expenses.list()), /can't view/, "Owner: no Expense")
  assert.equal(((await sqlAs(OWNER, `select count(*)::int n from expense.entries`))[0] as { n: number }).n, 0, "RLS: Owner reads no entry")
  await assert.rejects(sqlAs(EMP, `insert into audit.events (actor_kind, actor_user_id, actor_role, action, module, record_type, record_id) values ('SESSION', '${P.EMP}', 'EMPLOYEE', 'CREATED', 'Expense', 'Road tax', 'exp_x'); insert into expense.entries (id, section, date, company_code, description, amount) values ('exp_x', 'ROAD_TAX', '${today}', 'VT', 'MV TAX', 1)`), /row-level security/, "RLS: Employee can't write")

  /* ---------------------------------------------------------------- T-7 import from a browser backup: timestamps, outcomes, rollback */
  const created = "2026-11-20T09:02:15.851Z"
  const changed = "2026-11-21T10:47:05.599Z"
  const src = (id: string, x: Partial<Expense>) => ({ ...rt(), customerId: minda.id, companyConfirmed: true, driverId: null, billNo: "", requestId: null, importBatchId: null, id, createdAt: created, updatedAt: changed, ...x }) as Expense
  const settings = await read(DEV, () => api.settings.get())
  const file = (exp: Expense[], brokers: object[] = [], locks: object[] = []) => ({ format: "vishal-erp-backup", version: 1, exportedAt: "2026-11-27T08:00:00.000Z", settings, collections: { expenses: exp, brokers, expense_month_locks: locks } })
  const fileExp = [
    src("exp_mac000000001", { date: "2026-11-02", amount: 18000, description: "GREEN TAX" }),
    src("exp_mac000000002", { date: "2026-10-02", amount: 24000, vehicleIds: [v2.id] }),
    src("exp_mac000000003", { date: "2026-11-03", vehicleIds: ["veh_notcentral01"] }),
    src("exp_mac000000004", { date: `${sep}-03` }),
    src(tmp.id, { date: "2026-09-07" }),
    { ...src("exp_mac000000005", {}), section: "BROKER", entryType: "CHARGE", broker: "Mac Broker", billNo: "M1", description: "Mac bill", amount: 5000, vehicleIds: [], customerId: null, companyCode: null, companyConfirmed: undefined, taxType: "", date: "2026-11-05" } as Expense,
    { ...src("exp_mac000000006", {}), section: "BROKER", entryType: "PAYMENT", broker: "Mac Broker", description: "", amount: 0, paidAmount: 2000, paymentDate: "2026-11-06", vehicleIds: [], customerId: null, companyCode: null, companyConfirmed: undefined, taxType: "", date: "2026-11-06" } as Expense,
  ]
  const macBroker = { id: "brk_mac000000001", name: "Mac Broker", createdAt: created, updatedAt: changed }
  const f1 = file(fileExp, [macBroker, { id: "brk_mac000000002", name: "abc  bunk broker", createdAt: created, updatedAt: changed }])
  const before7 = await countAll()
  const plan = await read(DEV, () => api.expenseImport.importPlan(f1, "Office Mac — Chrome"))
  assert.deepEqual(await countAll(), before7, "dry run writes nothing")
  const outcome = (id: string) => plan.items.find((i) => i.sourceId === id)!
  assert.deepEqual([outcome("exp_mac000000001").outcome, outcome("exp_mac000000002").outcome, outcome("exp_mac000000003").outcome, outcome("exp_mac000000004").outcome, outcome(tmp.id).outcome],
    ["IMPORTED", "IMPORTED", "REJECTED", "REJECTED", "REJECTED"], "new · new · unknown vehicle · centrally locked month · deleted centrally")
  assert.match(outcome("exp_mac000000004").reason, /locked in Road Tax/)
  assert.match(outcome(tmp.id).reason, /deleted on the shared database/)
  assert.deepEqual([outcome("brk_mac000000001").outcome, outcome("brk_mac000000002").outcome], ["IMPORTED", "SKIPPED"], "brokers: new · matched by name")
  await assert.rejects(read(OWNER, () => api.expenseImport.importPlan(f1, "x")), /Only Dev/, "Dev only")
  const applied = await as(DEV, () => api.expenseImport.importApply(f1, "Office Mac — Chrome"))
  const bid = applied.batch.id
  // T-7.1 timestamps exactly as in the source.
  for (const id of ["exp_mac000000001", "exp_mac000000002", "exp_mac000000005", "exp_mac000000006"]) {
    const row = (await sqlAs(null, `select id, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') c, to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') u, date::text d, import_batch_id b from expense.entries where id = '${id}'`))[0] as { c: string; u: string; d: string; b: string }
    const source = fileExp.find((x) => x.id === id)!
    assert.deepEqual([row.c, row.u, row.d, row.b], [created, changed, source.date, bid], `T-7.1 ${id}: created_at, updated_at, date exact; batch set`)
    const viaApi = (await expenses()).find((x) => x.id === id)!
    assert.deepEqual([Date.parse(viaApi.createdAt), Date.parse(viaApi.updatedAt)], [Date.parse(created), Date.parse(changed)], "…through the API too (the database writes +00:00 for Z)")
    const evt = (await sqlAs(null, `select at, note from audit.events where record_id = '${id}' and action = 'CREATED'`))[0] as { at: Date; note: string }
    assert.ok(new Date(evt.at).getTime() > Date.parse(changed) && evt.note.includes(created), "the CREATED event's time is the import; its note keeps the original")
  }
  assert.deepEqual((await sqlAs(null, `select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') c from expense.brokers where id = 'brk_mac000000001'`)).map((r) => (r as { c: string }).c), [created], "a new broker keeps its timestamps")
  assert.equal(((await sqlAs(null, `select customer_id from expense.entries where id = 'exp_mac000000001'`))[0] as { customer_id: string }).customer_id, minda.id, "customer recomputed from the central assignment history")
  const again = await read(DEV, () => api.expenseImport.importPlan(f1, "Office Mac — Chrome"))
  assert.equal(again.appliedAs, bid, "the same file: already imported")
  await assert.rejects(as(DEV, () => api.expenseImport.importApply(f1, "Office Mac — Chrome")), /already imported/, "…refused")
  const f2 = file([...fileExp, { ...fileExp[0], amount: 1 }].filter((x, i) => i !== 0), [macBroker])
  const plan2 = await read(DEV, () => api.expenseImport.importPlan(f2, "Office Mac — later"))
  assert.equal(plan2.items.find((i) => i.sourceId === "exp_mac000000001")!.outcome, "CONFLICT", "same id, different content: conflict, never overwritten")
  assert.equal(plan2.items.find((i) => i.sourceId === "exp_mac000000002")!.outcome, "ALREADY_PRESENT", "a newer file: what is already there is skipped")

  // T-7.2 rollback reporting.
  await as(DEV, () => api.expenseMonths.lock("ROAD_TAX", "2026-10")) // exp_mac…002 (October Road Tax) now in a locked section-month
  const rb0 = await read(DEV, () => api.expenseImport.rollbackPlan(bid))
  assert.deepEqual([rb0.total.entries, rb0.eligible.sort(), rb0.retainedLocked], [4, ["exp_mac000000001", "exp_mac000000005", "exp_mac000000006"].sort(), ["exp_mac000000002"]], "(b) the locked entry retained")
  assert.match(rb0.status, /^PARTIAL — 1 of 4 imported entries remain \(1 in locked section-months/, "(e) the dry run never says COMPLETE")
  assert.deepEqual(await countAll(), { ...(await countAll()) }, "dry run writes nothing")
  const m1 = (await expenses()).find((x) => x.id === "exp_mac000000001")!
  await as(DEV, () => api.expenses.update(m1.id, { ...m1, remarks: "checked" }), true, { [m1.id]: m1.updatedAt })
  const rb1 = await as(DEV, () => api.expenseImport.rollbackApply(bid, "Wrong file"))
  assert.deepEqual([rb1.deleted.sort(), rb1.retainedChanged, rb1.retainedLocked], [["exp_mac000000005", "exp_mac000000006"].sort(), ["exp_mac000000001"], ["exp_mac000000002"]], "(c) changed after import retained; payments and bill of the open month deleted")
  assert.match(rb1.status, /^PARTIAL — 2 of 4/, "(h) partial is said so")
  assert.equal(((await sqlAs(null, `select count(*)::int n from audit.events where action = 'DELETED' and reason like 'Import rollback of batch ${bid}:%'`))[0] as { n: number }).n, 2, "(g) one DELETED event per deleted entry")
  assert.ok(((await sqlAs(null, `select note from audit.events where record_id = '${bid}' and action = 'UPDATED' order by at desc limit 1`))[0] as { note: string }).note.startsWith("Rollback PARTIAL"), "…and a summary event")
  const rb2 = await read(DEV, () => api.expenseImport.rollbackPlan(bid))
  assert.deepEqual([rb2.alreadyGone.length, rb2.eligible.length], [2, 0], "(f) a later run: earlier deletions are 'already gone'")
  assert.equal(((await sqlAs(null, `select count(*)::int n from expense.import_items where batch_id = '${bid}'`))[0] as { n: number }).n, plan.items.length, "(g) the batch and its items remain")
  const r29 = await run(readFileSync(new URL("29-expense-import-reconciliation.sql", RO), "utf8"))
  assert.ok(JSON.stringify(r29).includes("Rollback PARTIAL"), "29 reconciliation shows the same status")

  /* ---------------------------------------------------------------- T-5 reset scripts never touch Expense; script rules */
  const fingerprint = async () => JSON.stringify(await sqlAs(null, `select (select count(*) from expense.entries) e, (select sum(amount) from expense.entries) a, (select count(*) from expense.entry_vehicles) v, (select count(*) from expense.brokers) b, (select count(*) from expense.month_locks) l, (select count(*) from expense.import_batches) i`))
  const fp0 = await fingerprint()
  const reset03 = readFileSync(new URL("03-reset-business-data.sql", SCRIPTS), "utf8")
  const step2 = reset03.slice(reset03.indexOf("begin;\ndo $$"), reset03.lastIndexOf("commit;") + 7)
  await db.exec(`select set_config('vt.confirm_reset', 'dqnoducqiootfvkzskhu', false)`)
  await assert.rejects(db.exec(step2), /Expense records reference vehicles, customers or drivers this reset would delete/, "T-5.1 03 stops before deleting")
  await db.exec("rollback").catch(() => undefined)
  const reset05 = readFileSync(new URL("05-clean-reset-preserve-profiles.sql", SCRIPTS), "utf8")
  const aStart = reset05.indexOf("begin;\nselect set_config('vt.confirm_reset'")
  const partA = reset05.slice(aStart, reset05.indexOf("commit;", aStart) + 7).replace("TYPE-PROJECT-REF", "dqnoducqiootfvkzskhu")
  await assert.rejects(db.exec(partA), /Expense records reference/, "T-5.1 05 stops before deleting")
  await db.exec("rollback").catch(() => undefined)
  assert.equal(await fingerprint(), fp0, "…every Expense table unchanged")
  assert.ok(((await sqlAs(null, `select count(*)::int n from core.vehicles`))[0] as { n: number }).n >= 3, "…and nothing else deleted either")
  {
    // F3 05 Part B (both modes) never removes Expense audit history: on a separate database with Expense records that name
    // no vehicle / customer / driver (so Part A runs), an Expense DELETED event and its review, plus business events and a
    // business review. Part A, then Part B BUSINESS, then Part B ALL: every Expense table, event and review identical.
    const xdb = await freshDb(() => true)
    const xrun = async (sql: string) => (await xdb.exec(sql)).at(-1)?.rows as never[]
    const sys = (action: string, module: string, rec: string) => `insert into audit.events (actor_kind, action, module, record_type, record_id) values ('SYSTEM', '${action}', '${module}', 'x', '${rec}');`
    await xdb.exec(`${sys("CREATED", "Expense", "brk_r50000000001")} insert into expense.brokers (id, name) values ('brk_r50000000001', 'Reset Broker');
      ${sys("CREATED", "Expense", "exp_r50000000001")} insert into expense.entries (id, section, date, entry_type, broker_name, description, amount) values ('exp_r50000000001', 'BROKER', '2026-09-01', 'CHARGE', 'Reset Broker', 'bill', 900);
      ${sys("CREATED", "Expense", "exp_r50000000002")} insert into expense.entries (id, section, date, entry_type, broker_name, description, amount) values ('exp_r50000000002', 'BROKER', '2026-09-02', 'CHARGE', 'Reset Broker', 'temp', 50);
      ${sys("CREATED", "Expense", "eml_r50000000001")} insert into expense.month_locks (id, section, month, locked_by_role) values ('eml_r50000000001', 'BROKER', '2026-08', 'DEV');`)
    await xdb.exec(`${sys("DELETED", "Expense", "exp_r50000000002")} delete from expense.entries where id = 'exp_r50000000002';
      insert into audit.reviews (event_id, actor_role) select id, 'DEV' from audit.events where module = 'Expense' and action = 'DELETED';
      ${sys("CREATED", "Diesel", "die_r50000000001")} ${sys("DELETED", "Diesel", "die_r50000000001")}
      insert into audit.reviews (event_id, actor_role) select id, 'OWNER' from audit.events where module = 'Diesel' and action = 'DELETED';
      ${sys("CREATED", "Accounts", "acc_r50000000001")}`)
    const expenseRows = async () => JSON.stringify(await xrun(`select (select jsonb_agg(to_jsonb(e) order by id) from expense.entries e) e, (select jsonb_agg(to_jsonb(b) order by id) from expense.brokers b) b,
      (select jsonb_agg(to_jsonb(l) order by id) from expense.month_locks l) l, (select count(*) from expense.entry_vehicles) v, (select count(*) from expense.import_batches) i`))
    const expenseHistory = async () => JSON.stringify(await xrun(`select (select jsonb_agg(to_jsonb(e) order by id) from audit.events e where module = 'Expense') ev,
      (select jsonb_agg(to_jsonb(r) order by event_id) from audit.reviews r join audit.events e on e.id = r.event_id where e.module = 'Expense') rv`))
    const byModule = async () => Object.fromEntries(((await xrun(`select module, count(*)::int n from audit.events group by 1 order by 1`)) as { module: string; n: number }[]).map((r) => [r.module, r.n]))
    const reviewsOf = async (m: string) => ((await xrun(`select count(*)::int n from audit.reviews r join audit.events e on e.id = r.event_id where e.module = '${m}'`))[0] as { n: number }).n
    const rows0 = await expenseRows()
    const hist0 = await expenseHistory()
    assert.equal(JSON.parse(hist0)[0].ev.length, 5, "5 Expense events (broker, two bills, the lock; the removed bill's DELETED)")
    assert.equal(await reviewsOf("Expense"), 1)
    const REF = (sql: string) => sql.replace("TYPE-PROJECT-REF", "dqnoducqiootfvkzskhu")
    const aAt = reset05.indexOf("begin;\nselect set_config('vt.confirm_reset'")
    const bAt = reset05.lastIndexOf("begin;\nselect set_config('vt.confirm_reset'")
    const partA05 = REF(reset05.slice(aAt, reset05.indexOf("commit;", aAt) + 7))
    const partB05 = REF(reset05.slice(bAt, reset05.indexOf("commit;", bAt) + 7))
    await xdb.exec(partA05)
    assert.deepEqual([await expenseRows(), await expenseHistory()], [rows0, hist0], "F3 Part A: Expense records and Expense history untouched")
    await xdb.exec(partB05.replace("TYPE-MODE", "BUSINESS"))
    assert.deepEqual([await expenseRows(), await expenseHistory()], [rows0, hist0], "F3 Part B BUSINESS: every Expense record, event and review identical")
    assert.deepEqual(await byModule(), { Accounts: 1, Expense: 5, System: 1 }, "…business history cleared (Diesel, Part A's System events), Accounts and Expense kept, one marker")
    assert.deepEqual([await reviewsOf("Diesel"), await reviewsOf("Expense")], [0, 1], "…the business review removed, the Expense review kept")
    // The safety net: a Part B that would delete Expense history aborts before committing (here, both delete filters removed).
    const unsafe = partB05.replace("TYPE-MODE", "ALL").replace("where module <> 'Expense' and (mode = 'ALL' or module <> 'Accounts')", "where (mode = 'ALL' or module <> 'Accounts')").replace("e.module <> 'Expense' and (mode", "(mode")
    assert.notEqual(unsafe, partB05.replace("TYPE-MODE", "ALL"), "the delete statement was found")
    await assert.rejects(xdb.exec(unsafe), /Expense history is never reset/, "F3 a Part B that would remove Expense events aborts")
    await xdb.exec("rollback").catch(() => undefined)
    assert.deepEqual([await expenseRows(), await expenseHistory()], [rows0, hist0], "…nothing changed")
    await xdb.exec(partB05.replace("TYPE-MODE", "ALL"))
    assert.deepEqual([await expenseRows(), await expenseHistory()], [rows0, hist0], "F3 Part B ALL: every Expense record, event and review identical")
    assert.deepEqual(await byModule(), { Expense: 5, System: 1 }, "…everything else cleared, Accounts too; one marker")
    const guards = ((await xrun(`select count(*)::int n from pg_trigger where tgname in ('events_append_only', 'events_no_truncate', 'reviews_append_only', 'reviews_no_truncate') and tgenabled = 'O'`))[0] as { n: number }).n
    assert.equal(guards, 4, "…the append-only guard back on")
    await xdb.close()
  }
  // T-5.5 / T-5.6 every script states its effect; none writes expense.*; every READ-ONLY script runs read-only.
  const scriptFiles = [...readdirSync(SCRIPTS).filter((f) => f.endsWith(".sql")).map((f) => new URL(f, SCRIPTS)), ...readdirSync(RO).filter((f) => f.endsWith(".sql")).map((f) => new URL(f, RO))]
  for (const u of scriptFiles) {
    const text = readFileSync(u, "utf8")
    const name = u.pathname.split("/").pop()!
    // Every script that touches Expense states its effect on its first line (§8.5.4). Older scripts of other modules keep
    // their existing headers (not changed by Phase 2B).
    if (/expense/i.test(text)) assert.match(text, /^-- (READ-ONLY\.|DESTRUCTIVE —)/, `${name}: first line states READ-ONLY or DESTRUCTIVE`)
    const code = text.replace(/--[^\n]*/g, "")
    assert.ok(!/(insert\s+into|update|delete\s+from|truncate|alter\s+table|drop\s+\w+)\s+expense\./i.test(code), `${name}: never writes expense.*`)
    if (text.startsWith("-- READ-ONLY.") && name !== "02-backup-business-data.sql") {
      const statements = code.replace(/'(?:[^']|'')*'/g, "''") // words inside string literals (labels, messages) aren't statements
      assert.ok(!/\b(insert\s+into|update\s+\w+\.\w+\s+set|delete\s+from|truncate|alter\s+table|drop\s+(table|schema|function|policy)|create\s+(table|schema|policy)|grant|revoke)\b/i.test(statements), `${name}: no data or schema statement`)
      await db.exec("begin transaction read only")
      try {
        await db.exec(code)
      } catch (e) {
        if (!/does not exist|relation|function .* does not exist/i.test(String(e))) throw new Error(`${name} failed read-only: ${e}`)
      } finally {
        await db.exec("rollback").catch(() => undefined)
      }
    }
  }

  /* ---------------------------------------------------------------- T-9 the enforcement matrix (raw SQL, API bypassed) */
  const rawAs = (stmt: string, rec = "exp_raw00000001") => sqlAs(null, `insert into audit.events (actor_kind, action, module, record_type, record_id) values ('SYSTEM', 'CREATED', 'Expense', 'x', '${rec}'); ${stmt}`)
  await assert.rejects(rawAs(`insert into expense.entries (id, section, date, description, amount) values ('exp_raw00000001', 'ROAD_TAX', '${today}', 'MV TAX', 5)`), /entries_road_tax/, "Both: Road Tax paying company present")
  await assert.rejects(rawAs(`insert into expense.entries (id, section, date, company_code, description, amount) values ('exp_raw00000001', 'ROAD_TAX', '2099-01-01', 'VT', 'MV TAX', 5)`), /future/, "Both: no future date")
  await assert.rejects(rawAs(`insert into expense.entries (id, section, date, company_code, description, amount) values ('exp_raw00000001', 'ROAD_TAX', '${today}', 'VT', 'MV TAX', 5)`), /exactly one vehicle/, "Both: one vehicle per register entry")
  await assert.rejects(rawAs(`update expense.entries set section = 'FITNESS' where id = '${openRt.id}'`, openRt.id), /keeps its section/, "Both: type immutable")
  await assert.rejects(rawAs(`insert into expense.entries (id, section, date, entry_type, broker_name, bill_no, description, amount) values ('exp_raw00000001', 'BROKER', '${today}', 'CHARGE', 'ABC Bunk Broker', '001', 'dup', 5)`), /duplicate key/, "Both: bill number unique")
  await assert.rejects(rawAs(`insert into expense.entries (id, section, date, driver_id, company_code, description, amount) values ('exp_raw00000001', 'ROAD_TAX', '${today}', '${drv.id}', 'VT', 'MV', 5)`), /entries_driver_only_fines/, "Both: driver only on fines")
  // API only (D-15): accepted by raw SQL — the limitation stays visible.
  await as(OWNER, () => api.drivers.update(drv.id, { status: "ARCHIVED" }))
  await rawAs(`insert into expense.entries (id, section, date, driver_id, tax_type, amount, payment_status) values ('exp_raw00000002', 'FINE', '${today}', '${drv.id}', 'x', 5, 'UNPAID'); insert into expense.entry_vehicles values ('exp_raw00000002', 0, '${v1.id}')`, "exp_raw00000002")
  const archivedOk = ((await sqlAs(null, `select count(*)::int n from expense.entries where id = 'exp_raw00000002'`))[0] as { n: number }).n
  assert.equal(archivedOk, 1, "API only: an archived driver on a new fine is accepted by raw SQL (D-15)")
  await assert.rejects(as(DEV, () => api.expenses.create(base("FINE", { vehicleIds: [v1.id], taxType: "x", amount: 5, paymentStatus: "UNPAID", driverId: drv.id, requestId: rid() }))), /archived/, "…and refused by the API")
  await rawAs(`insert into expense.entries (id, section, date, customer_id, company_code, description, amount) values ('exp_raw00000003', 'ROAD_TAX', '${today}', null, 'VT', 'MV TAX', 5); insert into expense.entry_vehicles values ('exp_raw00000003', 0, '${v1.id}')`, "exp_raw00000003")
  assert.equal(((await sqlAs(null, `select count(*)::int n from expense.entries where id = 'exp_raw00000003' and customer_id is null`))[0] as { n: number }).n, 1, "API only: a customer that doesn't match the assignment is accepted by raw SQL (D-15)")

  const version = ((await db.exec("select current_setting('server_version') v"))[0].rows[0] as { v: string }).v
  await db.close()
  console.log(`expense on the shared database (migration, engine, idempotency, locks, audit, import, resets, enforcement) on PostgreSQL ${version}${PG_DIR ? " (local server)" : " (PGlite)"}: all checks passed`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
