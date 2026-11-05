/**
 * The shared database through the REAL driver:  npm run check:erp-driver
 * check:erp-db calls PGlite directly, which hands parameters over as-is. Production goes through Postgres.js, which
 * serialises each parameter by the type the server reports — that double-encoded the audit JSON and broke every write
 * in Production (3 Nov 2026), and would have cut the microsecond version token of every edit. This check runs the real
 * engine with the production connection options (pg-options.ts) over the PostgreSQL wire protocol (PGlite socket
 * server), as signed-in accounts with RLS on. Never touches a real project.
 */
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { PGlite } from "@electric-sql/pglite"
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist"
import { PGLiteSocketServer } from "@electric-sql/pglite-socket"
import postgres from "postgres"
import type { RequestIdentity } from "@/lib/request-scope"

const U = { DEV: "00000000-0000-0000-0000-0000000000e1", EMP: "00000000-0000-0000-0000-0000000000e3" }
const P = { DEV: "10000000-0000-0000-0000-0000000000e1", EMP: "10000000-0000-0000-0000-0000000000e3" }

async function main() {
  const { runInDatabase } = await import("./engine")
  const { PG_OPTIONS } = await import("./pg-options")
  const { api, ConflictError } = await import("@/lib/api")
  const { todayISO } = await import("@/lib/format")

  const db = new PGlite({ extensions: { btree_gist } })
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key, email text);
    -- As Supabase defines it: the claim setting, or the claims JSON.
    create function auth.uid() returns uuid language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated;
  `)
  const dir = new URL("../../../../supabase/migrations/", import.meta.url)
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) await db.exec(readFileSync(new URL(f, dir), "utf8"))
  await db.exec(`
    insert into auth.users values ('${U.DEV}', 'dev@example.com'), ('${U.EMP}', 'staff@example.com');
    insert into public.profiles (id, user_id, email, role, status, activated_at) values
      ('${P.DEV}', '${U.DEV}', 'dev@example.com', 'DEV', 'ACTIVE', now()), ('${P.EMP}', '${U.EMP}', 'staff@example.com', 'EMPLOYEE', 'ACTIVE', now());
    insert into audit.events (actor_kind, action, module, record_type, record_id) values
      ('SYSTEM', 'CREATED', 'Accounts', 'User account', '${P.DEV}'), ('SYSTEM', 'CREATED', 'Accounts', 'User account', '${P.EMP}');
  `)

  const server = new PGLiteSocketServer({ db, port: 0, host: "127.0.0.1" })
  await server.start()
  const port = Number(server.getServerConn().split(":").at(-1))
  // The production options (minus TLS, a local socket; one connection: the socket server serves one at a time).
  const client = postgres(`postgres://postgres:x@127.0.0.1:${port}/postgres`, { ...PG_OPTIONS, max: 1 })
  const transact = <T,>(fn: (sql: (t: string, p?: unknown[]) => Promise<never[]>) => Promise<T>) =>
    client.begin((tx) => fn((text, params) => tx.unsafe(text, (params ?? []) as never[]) as unknown as Promise<never[]>)) as Promise<T>
  const DEV: RequestIdentity = { profileId: P.DEV, userId: U.DEV, role: "DEV", email: "dev@example.com", name: null }
  const EMP: RequestIdentity = { profileId: P.EMP, userId: U.EMP, role: "EMPLOYEE", email: "staff@example.com", name: null }
  const as = <T,>(id: RequestIdentity, call: () => Promise<T>, write = true, expected: Record<string, string> = {}) => runInDatabase(transact as never, id, write, expected, call)
  const today = todayISO()

  try {
    /* -------------------------------------------------------------- 1. creating a fuel station (the Production failure) */
    const station = await as(DEV, () => api.fuelStations.create({ name: "Raghuveer Fuel Station", location: "Krishnagiri", creditDays: 30 }))
    const [ev] = await client`select jsonb_typeof(after) as after, jsonb_typeof(changes) as changes, after ->> 'name' as name from audit.events where record_id = ${station.id}`
    assert.deepEqual([ev.after, ev.changes, ev.name], ["object", "array", "Raghuveer Fuel Station"], "audit JSON is stored as JSON, not as a double-encoded string")
    // Visible after a "refresh" (a new request) — to another account too.
    const seen = (await as(EMP, () => api.fuelStations.list(), false)).find((s) => s.id === station.id)!
    assert.equal(seen.name, "Raghuveer Fuel Station")

    /* -------------------------------------------------------------- 2. editing with the version the screen showed (microseconds) */
    // Production's clock has microseconds (PGlite's has milliseconds): give the row a Production-like version.
    await db.exec(`set session_replication_role = replica; update fuel.fuel_stations set updated_at = '2026-11-03 09:24:48.820027+00' where id = '${station.id}'; set session_replication_role = origin;`)
    const seenMicro = (await as(EMP, () => api.fuelStations.list(), false)).find((s) => s.id === station.id)!
    assert.match(seenMicro.updatedAt, /\.820027/, "the version keeps the database's microseconds")
    seen.updatedAt = seenMicro.updatedAt
    await as(DEV, () => api.fuelStations.update(station.id, { name: "Raghuveer Fuel Station", location: "Krishnagiri Rd", creditDays: 21 }), true, { [station.id]: seen.updatedAt })
    const edited = (await as(EMP, () => api.fuelStations.list(), false)).find((s) => s.id === station.id)!
    assert.deepEqual([edited.location, edited.creditDays], ["Krishnagiri Rd", 21], "an edit with the current version is saved")
    await assert.rejects(as(DEV, () => api.fuelStations.update(station.id, { name: "X", location: "", creditDays: 1 }), true, { [station.id]: seen.updatedAt }), (e: unknown) => e instanceof ConflictError, "a stale version is refused")

    /* -------------------------------------------------------------- 3. dates keep their day (no Date / time-zone round trip) */
    const vehicle = await as(DEV, () =>
      api.vehicles.create({ regNo: "TN70AK1869", companyCode: "VT", typeCode: "BUS_55", make: "", model: "", year: 0, seats: null, fuelType: "DIESEL", mileageKmpl: 4, ownership: "OWNED", ownerName: null, status: "ACTIVE", odometerKm: 0, assignedCustomerId: null, defaultDriverId: null, insurance: { provider: "", policyNo: "", validTill: "2027-03-31", premium: 0 }, roadTax: { validTill: "", amount: 0, period: "ANNUAL" }, fitnessValidTill: "", permitValidTill: "", emiAmount: 0, notes: "" })
    )
    assert.equal((await as(DEV, () => api.vehicles.get(vehicle.id), false))!.insurance.validTill, "2027-03-31")

    /* -------------------------------------------------------------- 4. a fill, exact paise, visible to the other account */
    const fill = await as(EMP, () => api.diesel.create({ date: today, vehicleId: vehicle.id, customerId: null, vendorId: station.id, litres: 37.64, rate: 94.8, odometerKm: 1000, billNo: "", paymentMode: "CREDIT" }))
    const back = (await as(DEV, () => api.diesel.list(), false)).find((e) => e.id === fill.id)!
    assert.deepEqual([back.amount, back.date], [3568.27, today])
    // A half-paisa product: the database's generated amount (exact numeric) and the app's own rounding agree.
    const half = await as(EMP, () => api.diesel.create({ date: today, vehicleId: vehicle.id, customerId: null, vendorId: station.id, litres: 93.49, rate: 92.5, odometerKm: 1200, billNo: "", paymentMode: "CREDIT" }))
    const [{ amount: dbAmount }] = await client`select amount::text as amount from fuel.diesel_entries where id = ${half.id}`
    assert.deepEqual([dbAmount, half.amount], ["8647.83", 8647.83], "the screen's amount before save = the stored amount after")
    const halfNow = (await as(DEV, () => api.diesel.list(), false)).find((e) => e.id === half.id)!
    await as(DEV, () => api.diesel.remove(half.id, "Driver check: test entry"), true, { [half.id]: halfNow.updatedAt })
    const newer = (await as(DEV, () => api.diesel.list(), false)).find((e) => e.id === fill.id)!
    await as(DEV, () => api.diesel.remove(fill.id, "Driver check: test entry"), true, { [fill.id]: newer.updatedAt })
    assert.equal((await as(DEV, () => api.diesel.list(), false)).some((e) => e.id === fill.id), false, "a delete with the current version is saved")

    /* -------------------------------------------------------------- 4b. every API result survives JSON (the HTTP transport) */
    const ids = await as(DEV, () => api.audit.editedIds(), false)
    assert.ok(Array.isArray(JSON.parse(JSON.stringify(ids))) && ids.includes(station.id), "editedIds is plain JSON (a Set crashed the page in Production)")

    /* -------------------------------------------------------------- 5. a refused write never reports success */
    await assert.rejects(as(EMP, () => api.fuelStationPayments.recordTds({ stationId: station.id, month: today.slice(0, 7), amount: 100, companyCode: "VT", notes: "" })), /can't create payment/) // Employee: no TDS
    const [{ n }] = await client`select count(*)::int as n from finance.payments`
    assert.equal(n, 0)

    console.log("shared database through the real Postgres.js driver (wire protocol, production options): all checks passed")
  } finally {
    await client.end()
    await server.stop()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
