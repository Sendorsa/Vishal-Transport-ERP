/**
 * Integration check of the shared database backend:  npm run check:erp-db
 * The real `api.*` runs through the real server engine (src/lib/server/erp/engine.ts) on a real PostgreSQL (PGlite)
 * with every migration in supabase/migrations/, as signed-in accounts (DEV, OWNER, EMPLOYEE, TATA_ADBLUE, ADBLUE) — RLS, triggers and
 * deferred checks all apply. Never touches a real project. Single connection: genuinely simultaneous sessions (row /
 * advisory locks) are designed, not exercised here; stale screens and sequential races are.
 */
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { PGlite } from "@electric-sql/pglite"
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist"
import type { RequestIdentity } from "@/lib/request-scope"
import type { AdBlueEntry, AdBluePurchase, AuditEvent, Customer, DieselEntry, Driver, IndustrialSupply, TankerAdjustment, TankerTransfer, Vehicle } from "@/lib/types"
import type { AdBlueTotals } from "@/domain/adblue-inventory"

const U = { DEV: "00000000-0000-0000-0000-0000000000d1", OWNER: "00000000-0000-0000-0000-0000000000d2", EMP: "00000000-0000-0000-0000-0000000000d3", TATA: "00000000-0000-0000-0000-0000000000d4", ADB: "00000000-0000-0000-0000-0000000000d5", TATA2: "00000000-0000-0000-0000-0000000000d6" }
const P = { DEV: "10000000-0000-0000-0000-0000000000d1", OWNER: "10000000-0000-0000-0000-0000000000d2", EMP: "10000000-0000-0000-0000-0000000000d3", TATA: "10000000-0000-0000-0000-0000000000d4", ADB: "10000000-0000-0000-0000-0000000000d5", TATA2: "10000000-0000-0000-0000-0000000000d6" }

async function main() {
  const { runInDatabase, changesSince } = await import("./engine")
  const { api, ConflictError } = await import("@/lib/api")
  const { withVersions } = await import("@/lib/versions")
  const { currentRole } = await import("@/lib/identity")
  const { todayISO, round2, formatDate } = await import("@/lib/format")
  const { stationLedger, ledgerFor, openingOf } = await import("@/domain/station-ledger")
  const { loadsAsStationPurchases, valueTankers, tankerAvailability } = await import("@/domain/tanker")
  const { valueInventory, stockDraws, purchasedIn, stockFor } = await import("@/domain/adblue-inventory")
  const { settlementIndex, invoiceOutstanding, revenueInRange } = await import("@/domain/analytics")
  const { buildDieselIndex, fillMileage, fillRow } = await import("@/domain/diesel")
  const { searchVehicles } = await import("@/domain/assignments")

  /* ---------------------------------------------------------------- a real PostgreSQL with every migration */
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
  `)
  const dir = new URL("../../../../supabase/migrations/", import.meta.url)
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) await db.exec(readFileSync(new URL(f, dir), "utf8"))
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
  /** One API call as a signed-in account, in its own transaction (what the /api/erp route does per request). */
  const as = <T,>(id: RequestIdentity, call: () => Promise<T>, write = true, expected: Record<string, string> = {}) => runInDatabase(transact as never, id, write, expected, call)
  const read = <T,>(id: RequestIdentity, call: () => Promise<T>) => as(id, call, false)
  const sqlAs = async (id: RequestIdentity, text: string) => {
    await db.exec("begin")
    try {
      await db.exec(`set local role authenticated; select set_config('request.jwt.claim.sub', '${id.userId}', true);`)
      await db.exec(text)
      await db.exec("commit")
    } catch (e) {
      await db.exec("rollback").catch(() => undefined)
      throw e
    }
  }

  const today = todayISO()
  const B = "2026-10-31" // the go-live baseline (31 Oct 2026)
  assert.ok(today >= "2026-11-01", "this check assumes the clock is in November 2026 or later (October locked)")

  /* ---------------------------------------------------------------- 0. no verified account on the server = no identity (never Owner) */
  assert.throws(() => currentRole(), /Not signed in/)

  /* ---------------------------------------------------------------- 1. go-live setup by DEV appears for OWNER and EMPLOYEE */
  assert.equal(await as(DEV, () => api.admin.setupTankerMasters()), 6) // 3 tanker vehicles + 3 tankers
  assert.equal(await as(DEV, () => api.admin.setupTankerMasters()), 0) // idempotent
  const tk = await read(OWNER, () => api.tankers.list())
  assert.deepEqual(tk.map((t) => `${t.id} ${t.name} ${t.regNo} ${t.vehicleId}`).sort(), ["tnk_ka51af1429 Mini KA51AF1429 veh_ka51af1429", "tnk_ka53c0538 Office KA53C0538 veh_ka53c0538", "tnk_tn70ax9480 JIO TN70AX9480 veh_tn70ax9480"], "the confirmed tanker ids, linked to their vehicles")
  const tv = await read(EMP, () => api.vehicles.list())
  assert.deepEqual(tv.map((v) => [v.regNo, v.make, v.model, v.typeCode]).sort(), [["KA51AF1429", "", "", ""], ["KA53C0538", "", "", ""], ["TN70AX9480", "", "", ""]], "no invented make / model / type")
  const JIO = tk.find((t) => t.name === "JIO")!.id

  /* ---------------------------------------------------------------- 2. masters by OWNER, visible to EMPLOYEE; Assigned since */
  const station = await as(OWNER, () => api.fuelStations.create({ name: "Raghuveer Fuel Station", location: "Krishnagiri" }))
  const minda: Customer = await as(OWNER, () =>
    api.customers.create({ code: "MINDA", shortName: "Minda", name: "Minda Industries", legalName: "Minda Industries Ltd", companyCode: "VT", businessUnit: "STAFF_BUS", gstin: "33AAACM1234A1Z5", state: "Tamil Nadu", stateCode: "33", city: "Hosur", contactName: "", phone: "", email: "", creditDays: 30, pricing: { model: "PER_TRIP", rate: 1500, includedKm: 0, extraKmRate: 0, driverBata: 0, routes: [{ route: "Hosur–Bidadi", distanceKm: 80, rate: 2000 }] }, status: "ACTIVE", notes: "" })
  )
  const tepl = await as(OWNER, () => api.customers.create({ ...minda, code: "TEPL", shortName: "TEPL", name: "TEPL" } as never))
  const bus = await as(OWNER, () =>
    api.vehicles.create({ regNo: "TN70AK1869", companyCode: "VT", typeCode: "BUS_55", make: "", model: "", year: 0, seats: 55, fuelType: "DIESEL", mileageKmpl: 4.3, ownership: "OWNED", ownerName: null, status: "ACTIVE", odometerKm: 0, assignedCustomerId: minda.id, defaultDriverId: null, insurance: { provider: "", policyNo: "", validTill: "", premium: 0 }, roadTax: { validTill: "", amount: 0, period: "ANNUAL" }, fitnessValidTill: "", permitValidTill: "", emiAmount: 0, notes: "", assignedSince: "2026-10-01" })
  )
  const empCustomers = await read(EMP, () => api.customers.list())
  assert.equal(empCustomers.find((c) => c.id === minda.id)!.pricing.rate, 1500, "an Employee sees pricing it needs to price trips")
  assert.equal((await read(OWNER, () => api.customers.list())).find((c) => c.id === minda.id)!.pricing.routes[0].rate, 2000)
  const asg = (await read(EMP, () => api.assignments.list())).filter((a) => a.vehicleId === bus.id)
  assert.deepEqual(asg.map((a) => [a.customerId, a.startDate, a.endDate]), [[minda.id, "2026-10-01", null]], "Assigned since back-dates the first assignment")
  await assert.rejects(as(EMP, () => api.settings.update({ tdsRate: 3 })), /can't edit settings/) // Employee: the Owner's access except Settings (5 Nov 2026)
  await assert.rejects(as(OWNER, () => api.vehicles.create({ ...bus, regNo: "TN70ZZ0001", assignedSince: "2099-01-01" } as never)), /future/)

  /* ---------------------------------------------------------------- 3. openings at the baseline (Owner-level) */
  await assert.rejects(as(EMP, () => api.fuelStations.setOpeningBalance(station.id, { amount: 50000, date: B })), /October 2026 is locked/) // Owner-level, but the Employee follows the lock
  await as(OWNER, () => api.fuelStations.setOpeningBalance(station.id, { amount: 50000, date: B })) // we owe ₹50,000 at 31 Oct
  await as(DEV, () => api.tankerLoads.createOpening({ tankerId: JIO, date: B, litres: 1000, value: 95000, notes: "Dip at go-live" }))
  await as(OWNER, () => api.adbluePurchases.createOpening({ date: B, litres: 100, value: 9000, notes: "" }))
  await assert.rejects(as(EMP, () => api.vehicles.setOpeningOdometer(bus.id, { km: 120000, date: "2026-10-28" })), /October 2026 is locked/)
  await as(OWNER, () => api.vehicles.setOpeningOdometer(bus.id, { km: 120000, date: "2026-10-28" }))
  const oldInv = await as(OWNER, () => api.invoices.createOpening({ customerId: minda.id, invoiceNo: "VT/2026-27/045", date: "2026-10-05", dueDate: "2026-11-04", outstanding: 118000, notes: "Unpaid at go-live" }))
  assert.deepEqual([oldInv.opening, oldInv.status, oldInv.total, oldInv.lines.length], [true, "ISSUED", 118000, 0])

  /* ---------------------------------------------------------------- 4. EMPLOYEE fills; OWNER sees them; KM Run from the opening odometer */
  const fill = (litres: number, odometerKm: number, extra: object = {}) => ({ date: today, vehicleId: bus.id, customerId: minda.id, vendorId: station.id, litres, rate: 94.8, odometerKm, billNo: "", paymentMode: "CREDIT" as const, ...extra })
  const f1 = await as(EMP, () => api.diesel.create(fill(100, 120400)))
  assert.equal(f1.amount, 9480)
  const f2 = await as(EMP, () => api.diesel.create(fill(37.64, 120500, { paymentMode: "CASH" })))
  const ownerFills = await read(OWNER, () => api.diesel.list())
  assert.deepEqual(ownerFills.map((e) => e.amount).sort(), [3568.27, 9480], "exact paise from the database (37.64 × 94.80 = 3,568.272)")
  const ds = { vehicles: await read(OWNER, () => api.vehicles.list()), drivers: [], diesel: ownerFills, trips: [], customers: await read(OWNER, () => api.customers.list()), assignments: await read(OWNER, () => api.assignments.list()) } as never
  const idx = buildDieselIndex(ds)
  assert.equal(fillRow(idx, ownerFills.find((e) => e.id === f1.id)!).kmSince, 400, "first fill after go-live: KM Run from the opening odometer")
  // A tanker fill from JIO: stock falls, never a station purchase.
  const tf = await as(EMP, () => api.diesel.create(fill(300, 120700, { vendorId: "dv_tanker", tankerId: JIO, rate: 95 })))
  await assert.rejects(as(EMP, () => api.diesel.create(fill(800, 120900, { vendorId: "dv_tanker", tankerId: JIO, rate: 95 }))), /Insufficient tanker inventory in JIO. Available: 700 L/)
  // …and the database refuses it even if the API check were bypassed (deferred stock check at COMMIT).
  await assert.rejects(sqlAs(EMP, `insert into fuel.diesel_entries (company_code, date, vehicle_id, station_id, tanker_id, litres, rate, odometer_km) values ('VT', '${today}', '${bus.id}', 'dv_tanker', '${JIO}', 800, 95, 120950); insert into audit.events (actor_kind, actor_user_id, actor_role, action, module, record_type, record_id) select 'SESSION', '${P.EMP}', 'EMPLOYEE', 'CREATED', 'Diesel', 'Diesel entry', id from fuel.diesel_entries where litres = 800;`), /Insufficient tanker inventory/)
  const load = await as(OWNER, () => api.tankerLoads.create({ tankerId: JIO, date: today, stationId: station.id, invoiceNo: "L1", litres: 500, rate: 95.1, notes: "" }))
  const loads = await read(OWNER, () => api.tankerLoads.list())
  const fills = await read(OWNER, () => api.diesel.list())
  const v = valueTankers({ loads, fills, external: [], transfers: [], adjustments: [] })
  assert.equal(v.stock.get(JIO)!.litres, 1200, "JIO: 1,000 opening + 500 loaded − 300 filled")

  /* ---------------------------------------------------------------- 5. station ledger: Opening + Purchased − Paid = Closing; partial payment */
  // The Employee records station payments like the Owner (owner, 5 Nov 2026).
  await as(EMP, () => api.fuelStationPayments.create({ stationId: station.id, paymentDate: today, amount: 1000, paymentMode: "NEFT", notes: "", companyCode: "VT", forMonth: "2026-10" }))
  const pay = await as(OWNER, () => api.fuelStationPayments.create({ stationId: station.id, paymentDate: today, amount: 19000, paymentMode: "NEFT", notes: "", companyCode: "VT", forMonth: "2026-10" }))
  // The Employee's whole pump flow on the shared database (owner, 5 Nov 2026): add a pump, set its opening balance, pay it.
  const empPump = await as(EMP, () => api.fuelStations.create({ name: "Employee Check Pump" }))
  await as(EMP, () => api.fuelStations.setOpeningBalance(empPump.id, { amount: 7500, date: today }))
  const empPay = await as(EMP, () => api.fuelStationPayments.create({ stationId: empPump.id, paymentDate: today, amount: 2500, paymentMode: "UPI", notes: "", companyCode: "VT", forMonth: today.slice(0, 7) }))
  const ownerPump = (await read(OWNER, () => api.fuelStations.list())).find((s) => s.id === empPump.id)!
  assert.deepEqual([ownerPump.openingBalance, ownerPump.openingBalanceDate], [7500, today], "the Owner sees the Employee's pump and opening balance")
  assert.ok((await read(OWNER, () => api.fuelStationPayments.list())).some((p) => p.id === empPay.id && p.amount === 2500), "…and its payment")
  await as(EMP, () => api.fuelStationPayments.update(empPay.id, { paymentDate: today, amount: 3000, paymentMode: "UPI", notes: "" }))
  // Deleting: the Owner and Dev only (owner, 16 Nov 2026) — the API refuses the Employee, and so does RLS (below).
  await assert.rejects(as(EMP, () => api.fuelStationPayments.remove(empPay.id, "Entered on the wrong pump")), /can't delete payment records/)
  assert.ok((await read(OWNER, () => api.fuelStationPayments.list())).some((p) => p.id === empPay.id), "the Employee edits payments, but deletes none")
  await as(OWNER, () => api.fuelStationPayments.remove(empPay.id, "Entered on the wrong pump"))
  assert.ok(!(await read(OWNER, () => api.fuelStationPayments.list())).some((p) => p.id === empPay.id), "the Owner deletes it")
  // "Deduct TDS?" (owner, 17 Nov 2026): ₹1,00,000 at 0.1% = ₹99,900 paid + ₹100 TDS, through the engine; the database
  // checks the arithmetic itself (payments_station_tds_check) and keeps the monthly TDS entry's rules.
  const tdsPay = await as(EMP, () => api.fuelStationPayments.create({ stationId: empPump.id, paymentDate: today, amount: 100000, paymentMode: "NEFT", notes: "", companyCode: "VT", forMonth: today.slice(0, 7), tdsPercent: 0.1, reference: "UTR-77" }))
  const tdsRow = (await db.query<{ amount: string; tds: string; rate: string; reference: string }>(`select amount::text, tds_amount::text as tds, tds_rate::text as rate, reference from finance.payments where id = '${tdsPay.id}'`)).rows[0]
  assert.deepEqual([Number(tdsRow.amount), Number(tdsRow.tds), Number(tdsRow.rate), tdsRow.reference], [99900, 100, 0.1, "UTR-77"], "stored: ₹99,900 paid, ₹100 TDS, 0.1%, the UTR")
  const listedTds = (await read(OWNER, () => api.fuelStationPayments.list())).find((p) => p.id === tdsPay.id)!
  assert.deepEqual([listedTds.amount, listedTds.paidAmount, listedTds.tdsAmount, listedTds.tdsRate], [100000, 99900, 100, 0.1], "read back: total settled ₹1,00,000")
  const tdsPayNow = (await read(OWNER, () => api.payments.list())).find((p) => p.id === tdsPay.id)!
  await as(EMP, () => api.fuelStationPayments.update(tdsPay.id, { paymentDate: today, amount: 100000, paymentMode: "NEFT", notes: "", tdsPercent: 1 }, "1% applies"), true, { [tdsPay.id]: tdsPayNow.updatedAt })
  assert.deepEqual((await db.query<{ a: string; t: string }>(`select amount::text as a, tds_amount::text as t from finance.payments where id = '${tdsPay.id}'`)).rows[0], { a: "99000.00", t: "1000.00" }, "edited: ₹99,000 + ₹1,000")
  const evPay = (id: string) => `insert into audit.events (actor_kind, actor_user_id, actor_role, action, module, record_type, record_id) values ('SESSION', private.current_profile_id(), private.erp_role(), 'PAYMENT_RECORDED', 'Fuel Stations', 'Fuel station payment', '${id}');`
  const rawPay = (id: string, amount: number, tds: number, rate: string) => `insert into finance.payments (id, payment_no, company_code, direction, date, party_type, station_id, party_name, category_code, amount, tds_amount, tds_rate, mode, for_month) values ('${id}', '${id}', 'VT', 'OUT', '${today}', 'VENDOR', '${empPump.id}', 'P', 'DIESEL_SETTLEMENT', ${amount}, ${tds}, ${rate}, 'NEFT', '${today.slice(0, 7)}'); ${evPay(id)}`
  await assert.rejects(sqlAs(OWNER, rawPay("pay_tdsbad1", 99950, 50, "0.1")), /payments_station_tds_check/, "the database refuses TDS that isn't total × % (₹50 on ₹1,00,000 at 0.1%)")
  await assert.rejects(sqlAs(OWNER, rawPay("pay_tdsbad2", 99900, 100, "null")), /payments_station_tds_check/, "…and TDS on a payment without its %")
  await assert.rejects(sqlAs(OWNER, rawPay("pay_tdsbad3", 1000, 0, "-1")), /check constraint/, "…and a negative %")
  // ₹1,234.56 at 0.1% = ₹1.23 (round half away from zero, as the app): accepted by the CHECK (rolled back — nothing kept).
  await db.exec("begin")
  await db.exec(`set local role authenticated; select set_config('request.jwt.claim.sub', '${OWNER.userId}', true); ${rawPay("pay_tdsok", 1233.33, 1.23, "0.1")}`)
  await db.exec("rollback")
  const st = (await read(OWNER, () => api.fuelStations.list())).find((s) => s.id === station.id)!
  const purchases = [...fills, ...loadsAsStationPurchases(loads)]
  const led = stationLedger(station.id, purchases, await read(OWNER, () => api.payments.list()), today.slice(0, 7), openingOf(st))
  const nov = ledgerFor(led, [today.slice(0, 7)])
  const bought = round2(9480 + 3568.27 + round2(500 * 95.1)) // pump fills + the tanker load; never the tanker fill
  const paid = round2(1000 + 19000 + 3568.27) // the Employee's and the Owner's vouchers + cash at pump
  assert.deepEqual([nov.opening, nov.purchased, nov.paid, nov.closing], [50000, bought, paid, round2(50000 + bought - paid)])
  assert.equal(ledgerFor(led, ["2026-10"]).closing, 50000, "October closing = the opening balance, carried into November")
  // The payment never touched a fuel entry.
  assert.deepEqual((await read(OWNER, () => api.diesel.list())).map((e) => [e.id, e.updatedAt]).sort(), fills.map((e) => [e.id, e.updatedAt]).sort())
  // Odometer edits reach the database: the fill's reading, and the vehicle's last known km after a corrected typo.
  const busOdo = async () => (await read(OWNER, () => api.vehicles.get(bus.id)))!.odometerKm
  const tfEdit = (odometerKm: number) => ({ date: today, vendorId: "dv_tanker", tankerId: JIO, litres: 300, rate: 95, odometerKm, billNo: "", paymentMode: "CREDIT" as const })
  assert.equal(await busOdo(), 120700, "the database raised it on the new fill")
  await as(OWNER, () => api.diesel.update(tf.id, tfEdit(127000), "typo"))
  assert.deepEqual([(await read(OWNER, () => api.diesel.get(tf.id)))!.odometerKm, await busOdo()], [127000, 127000])
  await as(EMP, () => api.diesel.update(tf.id, tfEdit(120750), "typo corrected"))
  assert.deepEqual([(await read(OWNER, () => api.diesel.get(tf.id)))!.odometerKm, await busOdo()], [120750, 120750], "the corrected reading, and the cache lowered with it")
  await assert.rejects(as(EMP, () => api.diesel.update(tf.id, tfEdit(-1))), /Enter the odometer reading/)
  assert.equal((await read(OWNER, () => api.diesel.get(tf.id)))!.odometerKm, 120750, "a refused edit changes nothing")
  // The Odometer field of the vehicle form, changed on its own, is saved (it was dropped as "only the cache").
  await as(OWNER, () => api.vehicles.update(bus.id, { odometerKm: 121000 }))
  assert.equal(await busOdo(), 121000)
  // Mileage per fill from the database's readings = the same calculation on the values as entered (localStorage
  // backend): opening 120,000 → 120,400 (100 L) → 120,500 (37.64 L) → 120,750 (300 L, the corrected tanker fill).
  const dbFills = await read(OWNER, () => api.diesel.list())
  const dbIdx = buildDieselIndex({ vehicles: await read(OWNER, () => api.vehicles.list()), drivers: [], diesel: dbFills, trips: [], customers: [], assignments: await read(OWNER, () => api.assignments.list()) } as never)
  const kmplOf = (id: string) => fillRow(dbIdx, dbFills.find((e) => e.id === id)!).kmpl
  assert.deepEqual([kmplOf(f1.id), kmplOf(f2.id), kmplOf(tf.id)], [fillMileage(400, 100), fillMileage(100, 37.64), fillMileage(250, 300)])
  assert.deepEqual([kmplOf(f1.id), kmplOf(f2.id), kmplOf(tf.id)], [4, 2.66, 0.83])

  /* ---------------------------------------------------------------- 6. AdBlue: opening + bulk, FIFO draw from its vendor */
  const bulkBuy = await as(OWNER, () => api.adbluePurchases.create({ date: today, vendorName: "Bulk Vendor", product: "AdBlue", buckets: 10, litresPerBucket: 20, pricePerBucket: 900, invoiceNo: "", notes: "" }))
  const draw = await as(EMP, () => api.adblue.create({ date: today, vehicleId: bus.id, customerId: minda.id, closingKm: 120600, quantityLitres: 15, invoiceNo: "", notes: "", source: "STOCK", adblueVendorId: bulkBuy.adblueVendorId }))
  const ap = await read(OWNER, () => api.adbluePurchases.list())
  const inv = valueInventory(ap, stockDraws(await read(OWNER, () => api.adblue.list())))
  assert.deepEqual([inv.stockLitres, inv.stockValue, inv.costOf.get(draw.id)], [285, 17325, 675]) // FIFO from Bulk Vendor's batch (15 L × ₹45); the opening stock is "No vendor"
  // The vendor master on the shared database (16 Nov 2026): the purchase created its vendor; the draw reads back its source.
  const dbVendors = await read(EMP, () => api.adblueVendors.list())
  assert.deepEqual(dbVendors.filter((v) => v.id === bulkBuy.adblueVendorId).map((v) => [v.name, v.status]), [["Bulk Vendor", "ACTIVE"]])
  const dbDraw = (await read(OWNER, () => api.adblue.list())).find((e) => e.id === draw.id)!
  assert.deepEqual([dbDraw.adblueVendorId, dbDraw.sourceVendor, dbDraw.amount, dbDraw.costRate], [bulkBuy.adblueVendorId, "Bulk Vendor", 675, 45], "vendor, FIFO cost and rate survive the database")
  await assert.rejects(as(EMP, () => api.adblue.create({ date: today, vehicleId: bus.id, customerId: minda.id, closingKm: 120700, quantityLitres: 186, invoiceNo: "", notes: "", source: "STOCK", adblueVendorId: bulkBuy.adblueVendorId })), /Insufficient AdBlue stock from Bulk Vendor\. Available: 185L/, "a draw can't take another vendor's stock (the opening 100 L)")
  assert.deepEqual([purchasedIn(ap, (p) => p.date.startsWith("2026-10")).cost, purchasedIn(ap, () => true).cost], [0, 9000], "opening stock is never AdBlue Purchased")

  /* ---------------------------------------------------------------- 7. trips → invoice → receipts (allocations) */
  const trip = (n: number) => ({ date: today, customerId: minda.id, vehicleId: bus.id, driverId: null, route: "Hosur–Bidadi", startKm: 1000 * n, endKm: 1000 * n + 80, tollParking: 0, status: "COMPLETED" as const, notes: "" })
  const t1 = await as(EMP, () => api.trips.create(trip(1)))
  const t2 = await as(EMP, () => api.trips.create(trip(2)))
  assert.equal(t1.revenue, 2000, "priced from the route rate on the server")
  const invoice = await as(OWNER, () => api.invoices.create({ customerId: minda.id, date: today, periodFrom: today, periodTo: today, tripIds: [t1.id, t2.id], extraLines: [], taxRate: 18, notes: "", status: "ISSUED" }))
  assert.deepEqual([invoice.subtotal, round2(invoice.cgst + invoice.sgst + invoice.igst), invoice.total], [4000, 720, 4720])
  const ownerTrips = await read(OWNER, () => api.trips.list())
  assert.ok(ownerTrips.filter((t) => t.invoiceId === invoice.id).length === 2, "trips are locked to the invoice")
  await assert.rejects(as(EMP, () => api.trips.update(t1.id, trip(1))), /Invoiced trips are locked/)
  assert.equal((await read(EMP, () => api.invoices.list())).length, (await read(OWNER, () => api.invoices.list())).length, "the Employee reads invoices, like the Owner")
  const receipt = (amount: number, invoiceId: string, alloc: number) => ({ companyCode: "VT" as const, direction: "IN" as const, date: today, partyType: "CUSTOMER" as const, customerId: minda.id, vendorId: null, vehicleId: null, partyName: "Minda", categoryCode: null, amount, tdsAmount: 0, mode: "NEFT" as const, reference: "", allocations: [{ invoiceId, amount: alloc }], notes: "" })
  await as(OWNER, () => api.payments.create(receipt(2000, invoice.id, 2000))) // partial
  await assert.rejects(as(OWNER, () => api.payments.create(receipt(3000, invoice.id, 3000))), /exceeds outstanding/)
  await as(DEV, () => api.payments.create(receipt(100000, oldInv.id, 100000))) // the opening invoice, part paid
  const allPay = await read(OWNER, () => api.payments.list())
  const settled = settlementIndex(allPay)
  assert.deepEqual([invoiceOutstanding(invoice, settled.get(invoice.id) ?? 0), invoiceOutstanding(oldInv, settled.get(oldInv.id) ?? 0)], [2720, 18000])
  const numbers = allPay.map((p) => p.paymentNo)
  assert.equal(new Set(numbers).size, numbers.length, "voucher numbers never collide")
  assert.equal(revenueInRange({ trips: ownerTrips } as never, { from: "2026-10-01", to: today }), 4000, "revenue comes from trips — the opening invoice is never revenue")
  assert.equal((await read(EMP, () => api.payments.list())).length, allPay.length, "the Employee reads receipts and vouchers, like the Owner")

  /* ---------------------------------------------------------------- 8. optimistic concurrency: a stale screen never overwrites */
  const seen = (await read(OWNER, () => api.diesel.list())).find((e) => e.id === f1.id)! // OWNER opens the edit dialog
  await as(EMP, () => withVersions({ [f1.id]: seen.updatedAt }, () => api.diesel.update(f1.id, { ...fill(101, 120400), vendorId: station.id }, "Employee correction")), true, { [f1.id]: seen.updatedAt })
  const n0 = (await read(DEV, () => api.audit.list())).length
  await assert.rejects(as(OWNER, () => api.diesel.update(f1.id, { ...fill(150, 120400), vendorId: station.id }), true, { [f1.id]: seen.updatedAt }), (e: unknown) => e instanceof ConflictError)
  assert.equal((await read(OWNER, () => api.diesel.get(f1.id)))!.litres, 101, "the newer change is kept")
  assert.equal((await read(DEV, () => api.audit.list())).length, n0, "a refused edit records nothing")
  const fresh = (await read(OWNER, () => api.diesel.list())).find((e) => e.id === f1.id)!
  await as(OWNER, () => api.diesel.update(f1.id, { ...fill(102, 120400), vendorId: station.id }, "Owner after reload"), true, { [f1.id]: fresh.updatedAt })
  await assert.rejects(as(OWNER, () => api.diesel.remove(f1.id, "Stale delete"), true, { [f1.id]: fresh.updatedAt }), (e: unknown) => e instanceof ConflictError, "a stale delete is refused too")
  // Two payments in a row (one write at a time): distinct, gap-free numbers.
  const [pa, pb] = [await as(OWNER, () => api.fuelStationPayments.create({ stationId: station.id, paymentDate: today, amount: 1, paymentMode: "UPI", notes: "", companyCode: "VT", forMonth: "2026-11" })), await as(DEV, () => api.fuelStationPayments.create({ stationId: station.id, paymentDate: today, amount: 2, paymentMode: "UPI", notes: "", companyCode: "VT", forMonth: "2026-11" }))]
  assert.notEqual(pa.paymentNo, pb.paymentNo)
  // Editing a vehicle and changing its customer (the edit form, or Diesel → Add existing vehicle) transfers it first,
  // then saves the other fields — one call, one version. It used to refuse itself as "someone else changed this record".
  const spare = await as(OWNER, () => api.vehicles.create({ ...bus, regNo: "TN70ZZ0002", assignedCustomerId: null, status: "ACTIVE" } as never))
  const spareSeen = (await read(OWNER, () => api.vehicles.list())).find((x) => x.id === spare.id)!
  const { id: _sid, createdAt: _sc, updatedAt: _su, ...spareData } = spareSeen
  void [_sid, _sc, _su]
  await as(OWNER, () => api.vehicles.update(spare.id, { ...spareData, assignedCustomerId: tepl.id, notes: "Moved to TEPL" }), true, { [spare.id]: spareSeen.updatedAt })
  const spareNow = (await read(EMP, () => api.vehicles.list())).find((x) => x.id === spare.id)!
  assert.deepEqual([spareNow.assignedCustomerId, spareNow.notes], [tepl.id, "Moved to TEPL"], "the customer change and the other fields are both saved")
  assert.deepEqual((await read(EMP, () => api.assignments.list())).filter((a) => a.vehicleId === spare.id).map((a) => [a.customerId, a.startDate]), [[tepl.id, today]])
  await assert.rejects(as(OWNER, () => api.vehicles.update(spare.id, { ...spareData, assignedCustomerId: tepl.id, notes: "Stale" }), true, { [spare.id]: spareSeen.updatedAt }), (e: unknown) => e instanceof ConflictError, "a stale screen is still refused")
  assert.equal((await read(EMP, () => api.vehicles.list())).find((x) => x.id === spare.id)!.assignedCustomerId, tepl.id, "…and changed nothing")

  /* ---------------------------------------------------------------- 9. month lock: locked data — Employee refused, Dev and Owner allowed; lock / unlock — Owner and Dev only */
  const octFill = await as(OWNER, () => api.diesel.create({ ...fill(10, 119000), date: "2026-10-30" }))
  await assert.rejects(as(EMP, () => api.diesel.update(octFill.id, { ...fill(11, 119000), date: "2026-10-30", vendorId: station.id })), /October 2026 is locked/)
  await assert.rejects(as(EMP, () => api.diesel.remove(octFill.id, "Employee attempt")), /can't delete fuel records/)
  await as(DEV, () => api.diesel.update(octFill.id, { ...fill(12, 119000), date: "2026-10-30", vendorId: station.id }, "Dev correction in a closed month"))
  const lock = await as(DEV, () => api.monthLocks.set(today.slice(0, 7), "LOCKED"))
  assert.equal(lock.changedBy, "DEV")
  await assert.rejects(as(EMP, () => api.diesel.create(fill(5, 121000))), /is locked/) // a month locked early: closed to the Employee
  // Lock / unlock: the Owner and Dev only (owner, 11 Nov 2026) — the Employee is refused, but still sees the state.
  await assert.rejects(as(EMP, () => api.monthLocks.set(today.slice(0, 7), "OPEN")), /Only the Owner or Dev can lock or unlock a month/, "the Employee can't unlock it")
  await assert.rejects(as(EMP, () => api.monthLocks.set("2026-12", "LOCKED")), /Only the Owner or Dev can lock or unlock a month/, "…or lock a month")
  assert.equal((await read(EMP, () => api.monthLocks.list())).find((l) => l.month === today.slice(0, 7))?.state, "LOCKED", "…and it stays locked, visible to the Employee")
  assert.ok(!(await read(EMP, () => api.monthLocks.list())).some((l) => l.month === "2026-12"), "nothing was saved")
  assert.equal((await as(OWNER, () => api.monthLocks.set(today.slice(0, 7), "OPEN"))).changedBy, "OWNER", "the Owner unlocks it, recorded as itself")
  assert.equal((await as(OWNER, () => api.monthLocks.set(today.slice(0, 7), "LOCKED"))).changedBy, "OWNER", "…and locks it")
  assert.equal((await as(DEV, () => api.monthLocks.set(today.slice(0, 7), "OPEN"))).changedBy, "DEV", "Dev unlocks it again")

  /* ---------------------------------------------------------------- 10. delete with reason; Dev restores; audit identity */
  await assert.rejects(as(EMP, () => api.diesel.remove(f2.id, "Entered twice")), /can't delete fuel records/) // Owner and Dev only (16 Nov 2026)
  await assert.rejects(as(DEV, () => api.diesel.remove(f2.id, "")), /reason/i) // permission passes; the reason is still required
  await as(OWNER, () => api.diesel.remove(f2.id, "Entered twice"))
  const log = await read(DEV, () => api.audit.list())
  const del = log.find((e) => e.recordId === f2.id && e.action === "DELETED")!
  assert.deepEqual([del.actor.userId, del.actor.name, del.actor.role, del.reason], [P.OWNER, "Owner Person", "OWNER", "Entered twice"])
  assert.equal(await read(DEV, () => api.audit.unreviewedDeletions()), 2) // this one and the Employee's payment deletion
  assert.equal(await read(EMP, () => api.audit.unreviewedDeletions()), 2, "the Employee sees the same deletion badge")
  await as(DEV, () => api.audit.restoreDeleted(del.id, "Not a duplicate after all"))
  assert.ok(await read(OWNER, () => api.diesel.get(f2.id)), "restored with its original id")
  const after = await read(OWNER, () => api.audit.list())
  const restored = after.find((e) => e.restoresEventId === del.id)!
  assert.deepEqual([restored.actor.userId, restored.actor.role], [P.DEV, "DEV"])
  await assert.rejects(as(DEV, () => api.audit.restoreDeleted(del.id, "Again")), /Already restored/)
  const empEvent = after.find((e) => e.recordId === f1.id && e.action === "CREATED")!
  assert.deepEqual([empEvent.actor.userId, empEvent.actor.role, empEvent.actor.name], [P.EMP, "EMPLOYEE", "emp@example.com"], "the Employee's own identity — never another user's")
  // An Employee can't write an event in someone else's name, even straight to the database.
  await assert.rejects(sqlAs(EMP, `insert into audit.events (actor_kind, actor_user_id, actor_role, action, module, record_type, record_id) values ('SESSION', '${P.OWNER}', 'OWNER', 'CREATED', 'Diesel', 'Diesel entry', 'x')`), /row-level security/)
  // The Employee reads the whole log, like the Owner (owner, 5 Nov 2026) — RLS gives both the same events.
  assert.deepEqual((await read(EMP, () => api.audit.list())).map((e) => e.id), (await read(OWNER, () => api.audit.list())).map((e) => e.id), "Employee and Owner read the same audit log")

  /* ---------------------------------------------------------------- 11. transfer: entries after the effective date follow the new customer */
  await as(OWNER, () => api.vehicles.transfer(bus.id, tepl.id, today, "Moved to TEPL"))
  const newer = await as(EMP, () => api.diesel.create({ ...fill(20, 121500), customerId: tepl.id }))
  const resolvedList = await read(OWNER, () => api.diesel.list())
  assert.equal(resolvedList.find((e) => e.id === octFill.id)!.customerId, minda.id, "an October fill stays under Minda")
  assert.equal(resolvedList.find((e) => e.id === newer.id)!.customerId, tepl.id)
  await assert.rejects(as(EMP, () => api.diesel.create({ ...fill(20, 121600), customerId: minda.id })), /assigned to TEPL/)

  /* ---------------------------------------------------------------- 12. 20-second polling cursor: what changed, per role */
  const c0 = await changesSince(transact as never, EMP, null)
  await as(OWNER, () => api.payments.create(receipt(10, oldInv.id, 10)))
  await as(OWNER, () => api.diesel.create(fill(5, 122000, { customerId: tepl.id })))
  const empSees = await changesSince(transact as never, EMP, c0.cursor)
  assert.ok(empSees.modules.includes("Diesel"), "an Employee is told about new diesel entries")
  assert.ok(empSees.modules.includes("Payments"), "…and about receipts, like the Owner (5 Nov 2026)")
  assert.ok((await changesSince(transact as never, OWNER, c0.cursor)).modules.includes("Payments"))

  /* ---------------------------------------------------------------- 12a. tanker reloads: the API and the database agree, tanker by tanker */
  // Mini, on a vehicle of its own (Minda since October): load 6,000 → fill 5,500 → reload 5,000 dated today.
  const MINI = tk.find((t) => t.name === "Mini")!.id
  const OFFICE = tk.find((t) => t.name === "Office")!.id
  const day = (n: number) => new Date(Date.parse(today) - n * 86_400_000).toISOString().slice(0, 10)
  const van = await as(OWNER, () => api.vehicles.create({ regNo: "TN70ZZ4242", companyCode: "VT", typeCode: "BUS_55", make: "", model: "", year: 0, seats: 55, fuelType: "DIESEL", mileageKmpl: 4.3, ownership: "OWNED", ownerName: null, status: "ACTIVE", odometerKm: 0, assignedCustomerId: minda.id, defaultDriverId: null, insurance: { provider: "", policyNo: "", validTill: "", premium: 0 }, roadTax: { validTill: "", amount: 0, period: "ANNUAL" }, fitnessValidTill: "", permitValidTill: "", emiAmount: 0, notes: "", assignedSince: "2026-10-01" }))
  const vanFill = (tankerId: string, date: string, litres: number, odometerKm: number) => ({ date, vehicleId: van.id, customerId: minda.id, vendorId: "dv_tanker", tankerId, litres, rate: 95, odometerKm, billNo: "", paymentMode: "CREDIT" as const })
  const rawFill = (tankerId: string, date: string, litres: number, km: number) =>
    `insert into fuel.diesel_entries (company_code, date, vehicle_id, customer_id, station_id, tanker_id, litres, rate, odometer_km) values ('VT', '${date}', '${van.id}', '${minda.id}', 'dv_tanker', '${tankerId}', ${litres}, 95, ${km}); insert into audit.events (actor_kind, actor_user_id, actor_role, action, module, record_type, record_id) select 'SESSION', '${P.OWNER}', 'OWNER', 'CREATED', 'Diesel', 'Diesel entry', id from fuel.diesel_entries where vehicle_id = '${van.id}' and odometer_km = ${km};`
  await as(OWNER, () => api.tankerLoads.create({ tankerId: MINI, date: day(3), stationId: station.id, invoiceNo: "M1", litres: 6000, rate: 95, notes: "" }))
  await as(OWNER, () => api.diesel.create(vanFill(MINI, day(2), 5500, 1000)))
  await as(OWNER, () => api.tankerLoads.create({ tankerId: MINI, date: today, stationId: station.id, invoiceNo: "M2", litres: 5000, rate: 95, notes: "" }))
  // A fill dated before the reload: 500 L was there — the API and the database's own trigger both say so.
  await assert.rejects(as(OWNER, () => api.diesel.create(vanFill(MINI, day(1), 1000, 2000))), (e: Error) => e.message.startsWith(`Insufficient tanker inventory in Mini. Available: 500 L on ${formatDate(day(1))}. The next load into Mini (5,000 L) is dated ${formatDate(today)}`))
  await assert.rejects(sqlAs(OWNER, rawFill(MINI, day(1), 1000, 2000)), /Insufficient tanker inventory in Mini\. Available: 500\.00 L/)
  // On the reload's own date it fits (the load comes first); both draw the line at exactly the same litres.
  await as(OWNER, () => api.diesel.create(vanFill(MINI, today, 1000, 3000)))
  const miniNow = tankerAvailability({ loads: await read(OWNER, () => api.tankerLoads.list()), fills: await read(OWNER, () => api.diesel.list()), external: [], transfers: [], adjustments: [] }, { id: "new", date: today, createdAt: new Date().toISOString(), tankerId: MINI })
  assert.equal(miniNow.available, 4500)
  await assert.rejects(sqlAs(OWNER, rawFill(MINI, today, 4500.01, 4000)), /Insufficient tanker inventory in Mini\. Available: 4500\.00 L/)
  await assert.rejects(as(OWNER, () => api.diesel.create(vanFill(MINI, today, 4500.01, 4000))), /Insufficient tanker inventory in Mini\. Available: 4,500 L/)
  await as(OWNER, () => api.diesel.create(vanFill(MINI, today, 4500, 4000)))
  // Office's history goes below zero (a row written with the triggers off — e.g. old data): Mini is not blocked.
  await db.exec(`set session_replication_role = replica; insert into fuel.diesel_entries (id, company_code, date, vehicle_id, customer_id, station_id, tanker_id, litres, rate, odometer_km) values ('dsl_broken_office', 'VT', '2026-10-02', '${van.id}', '${minda.id}', 'dv_tanker', '${OFFICE}', 100, 95, 1); set session_replication_role = origin;`)
  await as(OWNER, () => api.tankerLoads.create({ tankerId: MINI, date: today, stationId: station.id, invoiceNo: "M3", litres: 200, rate: 95, notes: "" }))
  await as(OWNER, () => api.diesel.create(vanFill(MINI, today, 200, 5000))) // the API and the database check Mini only
  await assert.rejects(as(OWNER, () => api.diesel.create(vanFill(OFFICE, today, 1, 6000))), /Office's records already go below zero on 02-10-2026/)
  await db.exec(`set session_replication_role = replica; delete from fuel.diesel_entries where id = 'dsl_broken_office'; set session_replication_role = origin;`)

  /* ---------------------------------------------------------------- 12b. Edit Assignment: start-date correction, audited in the same transaction */
  const late = await as(OWNER, () => api.vehicles.create({ regNo: "TN70ZZ5151", companyCode: "VT", typeCode: "BUS_55", make: "", model: "", year: 0, seats: 55, fuelType: "DIESEL", mileageKmpl: 4.3, ownership: "OWNED", ownerName: null, status: "ACTIVE", odometerKm: 0, assignedCustomerId: minda.id, defaultDriverId: null, insurance: { provider: "", policyNo: "", validTill: "", premium: 0 }, roadTax: { validTill: "", amount: 0, period: "ANNUAL" }, fitnessValidTill: "", permitValidTill: "", emiAmount: 0, notes: "", assignedSince: today }))
  const asgRow = async () => (await db.query<{ id: string; start_date: string; customer_id: string; end_date: string | null; status: string }>(`select id, to_char(start_date, 'YYYY-MM-DD') as start_date, customer_id, end_date, status from core.vehicle_assignments where vehicle_id = '${late.id}'`)).rows
  const [lateAsg] = await asgRow()
  assert.deepEqual([lateAsg.start_date, lateAsg.customer_id], [today, minda.id])
  // Straight to the database without an audit event: refused by private.require_parent_audit_event at COMMIT.
  await assert.rejects(sqlAs(OWNER, `update core.vehicle_assignments set start_date = '${day(1)}' where id = '${lateAsg.id}'`), /has no audit event in the same transaction/)
  // A session without an ERP account changes nothing (RLS: the row isn't visible to update).
  await sqlAs({ ...OWNER, userId: "00000000-0000-4000-8000-0000000000ff", profileId: "nobody" }, `update core.vehicle_assignments set start_date = '${day(1)}' where id = '${lateAsg.id}'`)
  assert.equal((await asgRow())[0].start_date, today)
  // Through the API: the same row, a new start date, and its UPDATED event in the same transaction.
  await as(OWNER, () => api.assignments.correctStartDate(lateAsg.id, { startDate: day(1), reason: "Correction of incorrectly entered assignment start date" }), true, { [lateAsg.id]: (await read(OWNER, () => api.assignments.list())).find((a) => a.id === lateAsg.id)!.updatedAt })
  assert.deepEqual(await asgRow(), [{ ...lateAsg, start_date: day(1) }], "same id, customer, end date and status")
  const corr = (await db.query<{ action: string; reason: string; actor_role: string; same_tx: boolean }>(`select e.action, e.reason, e.actor_role, e.txid = (select xmin::text::bigint from core.vehicle_assignments where id = '${lateAsg.id}') as same_tx from audit.events e where e.record_id = '${late.id}' and e.record_type = 'Vehicle assignment' order by e.at desc limit 1`)).rows[0]
  assert.deepEqual(corr, { action: "UPDATED", reason: "Correction of incorrectly entered assignment start date", actor_role: "OWNER", same_tx: true })
  // A stale screen (someone corrected it meanwhile) is refused, nothing saved.
  await assert.rejects(as(OWNER, () => api.assignments.correctStartDate(lateAsg.id, { startDate: day(2), reason: "Second correction" }), true, { [lateAsg.id]: "2000-01-01T00:00:00.000000+00:00" }), /Someone else changed this record/)
  assert.equal((await asgRow())[0].start_date, day(1))

  /* ---------------------------------------------------------------- 12c. Back-dated transfer, then its date corrected: both assignments, one transaction */
  const moving = await as(OWNER, () => api.vehicles.create({ regNo: "TN70ZZ5252", companyCode: "VT", typeCode: "BUS_55", make: "", model: "", year: 0, seats: 55, fuelType: "DIESEL", mileageKmpl: 4.3, ownership: "OWNED", ownerName: null, status: "ACTIVE", odometerKm: 0, assignedCustomerId: minda.id, defaultDriverId: null, insurance: { provider: "", policyNo: "", validTill: "", premium: 0 }, roadTax: { validTill: "", amount: 0, period: "ANNUAL" }, fitnessValidTill: "", permitValidTill: "", emiAmount: 0, notes: "", assignedSince: day(10) }))
  type Asg = { id: string; customer_id: string; start_date: string; end_date: string | null; status: string; xmin: string }
  const movingRows = async () => (await db.query<Asg>(`select id, customer_id, to_char(start_date, 'YYYY-MM-DD') as start_date, to_char(end_date, 'YYYY-MM-DD') as end_date, status, xmin::text as xmin from core.vehicle_assignments where vehicle_id = '${moving.id}' order by start_date`)).rows
  const shape = (rows: Asg[]) => rows.map((r) => [r.customer_id, r.start_date, r.end_date, r.status])
  const lastEvents = async (n: number) => (await db.query<{ action: string; reason: string; actor_role: string; txid: string }>(`select action, reason, actor_role, txid::text as txid from audit.events where record_id = '${moving.id}' and record_type = 'Vehicle assignment' order by at desc limit ${n}`)).rows
  await assert.rejects(as(OWNER, () => api.vehicles.transfer(moving.id, tepl.id, day(3))), /Enter the reason for back-dating/)
  await as(OWNER, () => api.vehicles.transfer(moving.id, tepl.id, day(3), "Started with TEPL; transfer entered late"))
  const [mOld, mNew] = await movingRows()
  assert.deepEqual(shape([mOld, mNew]), [[minda.id, day(10), day(4), "ENDED"], [tepl.id, day(3), null, "ACTIVE"]], "previous closed the day before, new one from the effective date")
  const [tEv] = await lastEvents(1)
  assert.deepEqual([tEv.action, tEv.reason, tEv.actor_role, tEv.txid === mOld.xmin && tEv.txid === mNew.xmin], ["TRANSFERRED", "Started with TEPL; transfer entered late", "OWNER", true], "both rows and the event in one transaction")
  const versionsOf = async () => Object.fromEntries((await read(OWNER, () => api.assignments.list())).filter((a) => a.vehicleId === moving.id).map((a) => [a.id, a.updatedAt]))
  // Earlier (Minda gives up days — written first, the no-overlap constraint is checked per statement), then later (TEPL gives them back).
  for (const [start, prevEnd] of [[day(6), day(7)], [day(2), day(3)]]) {
    await as(OWNER, () => api.assignments.correctStartDate(mNew.id, { startDate: start, reason: "Correction of incorrectly entered transfer date" }), true, await versionsOf())
    const rows = await movingRows()
    assert.deepEqual(shape(rows), [[minda.id, day(10), prevEnd, "ENDED"], [tepl.id, start, null, "ACTIVE"]], `transfer date corrected to ${start}`)
    assert.deepEqual(rows.map((r) => r.id), [mOld.id, mNew.id], "the same two assignments")
    const evs = await lastEvents(2)
    assert.ok(evs.every((e) => e.action === "UPDATED" && e.reason === "Correction of incorrectly entered transfer date" && e.txid === rows[0].xmin && e.txid === rows[1].xmin), "one UPDATED event per assignment, in the same transaction")
  }
  // A stale previous assignment (someone changed it meanwhile) is refused, nothing saved.
  await assert.rejects(as(OWNER, () => api.assignments.correctStartDate(mNew.id, { startDate: day(5), reason: "Stale" }), true, { ...(await versionsOf()), [mOld.id]: "2000-01-01T00:00:00.000000+00:00" }), /Someone else changed this record/)
  assert.deepEqual(shape(await movingRows()), [[minda.id, day(10), day(3), "ENDED"], [tepl.id, day(2), null, "ACTIVE"]])

  /* ---------------------------------------------------------------- 12d. The AdBlue profiles: Tata Adblue (granted customers) and Adblue (owner, 11 Nov 2026) */
  {
    const { profileCall, PROFILE_METHODS } = await import("./profiles")
    const { isReadMethod } = await import("@/lib/api/reads")
    const { withRuns } = await import("@/domain/adblue")
    await db.exec(`
      insert into auth.users values ('${U.TATA}', 'tata@example.com'), ('${U.ADB}', 'adblue@example.com'), ('${U.TATA2}', 'tata2@example.com');
      insert into public.profiles (id, user_id, email, full_name, role, status, activated_at) values
        ('${P.TATA}', '${U.TATA}', 'tata@example.com', 'Tata Person', 'TATA_ADBLUE', 'ACTIVE', now()),
        ('${P.ADB}', '${U.ADB}', 'adblue@example.com', null, 'ADBLUE', 'ACTIVE', now()),
        ('${P.TATA2}', '${U.TATA2}', 'tata2@example.com', null, 'TATA_ADBLUE', 'ACTIVE', now());
      insert into audit.events (actor_kind, action, module, record_type, record_id) values
        ('SYSTEM', 'CREATED', 'Accounts', 'User account', '${P.TATA}'), ('SYSTEM', 'CREATED', 'Accounts', 'User account', '${P.ADB}'), ('SYSTEM', 'CREATED', 'Accounts', 'User account', '${P.TATA2}');
    `)
    const TATA = who("TATA", "TATA_ADBLUE", "Tata Person")
    const ADB = who("ADB", "ADBLUE", null)
    const TATA2 = who("TATA2", "TATA_ADBLUE", null)
    const methods = api as unknown as Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>>
    /** What POST /api/erp does: the role's method list (profileCall), then the call in its own transaction. */
    const call = async <T,>(id: RequestIdentity, method: string, ...args: unknown[]): Promise<T> => {
      const [ns, m] = method.split(".")
      const c = profileCall(id.role, method, () => methods[ns][m](...args))
      if (!c) throw new Error(`refused by the method list: ${method}`)
      return (await as(id, c, !isReadMethod(ns, m))) as T
    }
    /** Rows as a signed-in user sees them straight from the database (RLS), in a rolled-back transaction. */
    const rowsAs = async <T,>(id: RequestIdentity, text: string): Promise<T[]> => {
      await db.exec("begin")
      try {
        await db.exec(`set local role authenticated; select set_config('request.jwt.claim.sub', '${id.userId}', true);`)
        return (await db.query<T>(text)).rows
      } finally {
        await db.exec("rollback")
      }
    }
    const grant = (id: RequestIdentity, profileId: string, ids: string[], reason: string) => sqlAs(id, `select public.set_customer_access('${profileId}', array[${ids.map((x) => `'${x}'`).join(", ")}]::text[], '${reason}')`)
    const grants = async (profileId: string) => (await db.query<{ c: string }>(`select customer_id as c from core.profile_customer_access where profile_id = '${profileId}' order by 1`)).rows.map((r) => r.c)

    // Customers Alpha (granted to Tata Adblue) and Beta (not); vehicle X moves Beta → Alpha.
    const mkCust = (code: string) => as(OWNER, () => api.customers.create({ ...minda, code, shortName: code, name: code } as never))
    const alpha = await mkCust("ALPHA")
    const beta = await mkCust("BETA")
    const veh = (regNo: string, customerId: string, since = day(9)) => as(OWNER, () => api.vehicles.create({ regNo, companyCode: "VT", typeCode: "BUS_55", make: "", model: "", year: 0, seats: 55, fuelType: "DIESEL", mileageKmpl: 4.3, ownership: "OWNED", ownerName: null, status: "ACTIVE", odometerKm: 0, assignedCustomerId: customerId, defaultDriverId: null, insurance: { provider: "", policyNo: "", validTill: "", premium: 0 }, roadTax: { validTill: "", amount: 0, period: "ANNUAL" }, fitnessValidTill: "", permitValidTill: "", emiAmount: 0, notes: "", assignedSince: since }))
    const vA = await veh("TN70PA0001", alpha.id)
    const vB = await veh("TN70PB0002", beta.id)
    const vX = await veh("TN70PX0003", beta.id)
    const dfill = (vehicleId: string, customerId: string, date: string, odometerKm: number) => ({ date, vehicleId, customerId, vendorId: station.id, litres: 50, rate: 95, odometerKm, billNo: "", paymentMode: "CREDIT" as const })
    // These draws are back-dated: a vendor batch dated before them (the opening stock has no vendor, so no draw takes it).
    const earlyBuy = await as(OWNER, () => api.adbluePurchases.create({ date: day(9), vendorName: "Early Vendor", product: "AdBlue", buckets: 5, litresPerBucket: 20, pricePerBucket: 900, invoiceNo: "", notes: "" }))
    const ab = (vehicleId: string, customerId: string, date: string, closingKm: number, quantityLitres: number) => ({ date, vehicleId, customerId, closingKm, quantityLitres, invoiceNo: "", notes: "", source: "STOCK" as const, adblueVendorId: earlyBuy.adblueVendorId })
    const dX1 = await as(OWNER, () => api.diesel.create(dfill(vX.id, beta.id, day(8), 1000)))
    await as(OWNER, () => api.adblue.create(ab(vX.id, beta.id, day(8), 1000, 5)))
    await as(OWNER, () => api.vehicles.transfer(vX.id, alpha.id, day(6), "Moved to Alpha"))
    const dX2 = await as(OWNER, () => api.diesel.create(dfill(vX.id, alpha.id, day(5), 1400)))
    const aX2 = await as(OWNER, () => api.adblue.create(ab(vX.id, alpha.id, day(5), 1400, 4)))
    await as(OWNER, () => api.diesel.create(dfill(vB.id, beta.id, day(5), 500)))
    const aB = await as(OWNER, () => api.adblue.create(ab(vB.id, beta.id, day(5), 500, 3)))

    // The method list: exactly these, every other api method refused for both profiles (and nothing changes for the others).
    for (const role of ["TATA_ADBLUE", "ADBLUE"] as const) {
      const writes = PROFILE_METHODS.filter((m) => !isReadMethod(m.split(".")[0], m.split(".")[1]))
      assert.deepEqual(writes.sort(), ["adblue.create", "adblue.update", "adbluePurchases.create"], `${role}: the only writes: AdBlue entries (add / edit — no delete, 16 Nov 2026) and bulk purchases`)
    }
    assert.ok(["adblue.list", "adblueStock.list", "adblueVehicles.list", "adblueTotals.get", "adbluePurchases.list", "adblueVendors.list"].every((m) => PROFILE_METHODS.includes(m)), "both profiles: every AdBlue read (owner, 12 Nov 2026)")
    for (const ns of Object.keys(methods))
      for (const m of Object.keys(methods[ns])) {
        const name = `${ns}.${m}`
        for (const role of ["TATA_ADBLUE", "ADBLUE"] as const) assert.equal(profileCall(role, name, async () => 1) !== null, PROFILE_METHODS.includes(name), `${role}: ${name}`)
        for (const role of ["OWNER", "DEV", "EMPLOYEE"] as const) assert.ok(profileCall(role, name, async () => 1), `${role} keeps ${name}`)
      }
    for (const m of ["diesel.create", "diesel.update", "diesel.remove", "tankerLoads.create", "tankerTransfers.create", "tankerAdjustments.create", "fuelStations.create", "fuelStationPayments.create", "payments.create", "vehicles.transfer", "vehicles.update", "customers.create", "assignments.correctStartDate", "monthLocks.set", "settings.update", "adbluePurchases.update", "adbluePurchases.remove", "adbluePurchases.createOpening", "audit.list", "audit.history", "audit.restoreDeleted", "admin.exportBackup", "diesel.get"])
      for (const id of [TATA, ADB]) await assert.rejects(call(id, m), /refused by the method list/, `${id.role}: ${m}`)

    // Before any grant, Tata Adblue sees no customer and can add nothing.
    assert.deepEqual(await call(TATA, "customers.list"), [])
    await assert.rejects(call(TATA, "adblue.create", ab(vA.id, alpha.id, today, 2000, 1)), /for this customer/)

    // Dev grants Alpha — Dev only, a reason, Tata Adblue accounts only, never a direct write; audited.
    await assert.rejects(grant(OWNER, P.TATA, [alpha.id], "Owner attempt"), /Only Dev/)
    await assert.rejects(grant(EMP, P.TATA, [alpha.id], "Employee attempt"), /Only Dev/)
    await assert.rejects(grant(TATA, P.TATA, [alpha.id], "Self grant"), /Only Dev/)
    await assert.rejects(grant(DEV, P.ADB, [alpha.id], "Wrong role"), /only for Tata Adblue/)
    await assert.rejects(grant(DEV, P.TATA, [alpha.id], " "), /reason/)
    await assert.rejects(grant(DEV, P.TATA, ["cus_nope"], "Typo"), /Customer not found/)
    await assert.rejects(sqlAs(DEV, `insert into core.profile_customer_access (profile_id, customer_id, granted_by) values ('${P.TATA}', '${alpha.id}', '${P.DEV}')`), /permission denied/)
    await assert.rejects(rowsAs(TATA, `select * from public.list_customer_access()`), /Only Dev/)
    await assert.rejects(db.exec(`insert into core.profile_customer_access (profile_id, customer_id, granted_by) values ('${P.TATA}', '${alpha.id}', '${P.DEV}')`), /no audit event/, "even the database owner needs the audit event")
    await grant(DEV, P.TATA, [alpha.id], "Tata contract: Alpha")
    assert.deepEqual(await grants(P.TATA), [alpha.id])
    assert.deepEqual((await rowsAs<{ customer_id: string }>(DEV, `select customer_id from public.list_customer_access() where profile_id = '${P.TATA}'`)).map((r) => r.customer_id), [alpha.id])
    const grantEv = (await db.query<{ action: string; actor_role: string; reason: string; label: string; access: string; changes: unknown }>(`select action, actor_role::text, reason, label, after ->> 'access' as access, changes from audit.events where module = 'Accounts' and record_type = 'Customer access' and record_id = '${P.TATA}'`)).rows
    assert.deepEqual(grantEv.map((e) => [e.action, e.actor_role, e.reason, e.label, e.access]), [["UPDATED", "DEV", "Tata contract: Alpha", "tata@example.com · ALPHA · access granted", "Granted"]], "one audited grant, by Dev, with its reason")
    assert.deepEqual(grantEv[0].changes, [{ field: "access", before: "Not granted", after: "Granted" }])
    await grant(DEV, P.TATA, [alpha.id], "No change") // nothing to grant or revoke: nothing recorded
    assert.equal((await db.query(`select 1 from audit.events where record_type = 'Customer access' and record_id = '${P.TATA}'`)).rows.length, 1)
    assert.deepEqual((await rowsAs<{ customer_id: string }>(TATA, `select customer_id from core.profile_customer_access`)).map((r) => r.customer_id), [alpha.id], "Tata Adblue reads only its own grants")
    assert.deepEqual(await rowsAs(TATA2, `select customer_id from core.profile_customer_access`), [], "…another account none of them")

    // Reads: Tata Adblue — Alpha only, computed on everything; Adblue — every customer, exactly as the Owner sees it.
    const tCustomers = await call<Customer[]>(TATA, "customers.list")
    assert.deepEqual(tCustomers.map((c) => c.id), [alpha.id], "granted customers only")
    const tVehicles = await call<{ id: string; assignedCustomerId: string | null }[]>(TATA, "vehicles.list")
    assert.deepEqual(tVehicles.map((v) => v.id).sort(), [vA.id, vX.id].sort(), "vehicles that worked for Alpha — never Beta's")
    assert.ok(tVehicles.every((v) => v.assignedCustomerId === alpha.id))
    const tAsg = await call<{ customerId: string }[]>(TATA, "assignments.list")
    assert.ok(tAsg.length === 2 && tAsg.every((a) => a.customerId === alpha.id), "Alpha's assignments only (X's Beta period isn't shown)")
    assert.deepEqual(await call(TATA, "drivers.list"), [])
    const tDiesel = await call<(DieselEntry & { prevOdometerKm: number | null })[]>(TATA, "diesel.list")
    assert.deepEqual(tDiesel.map((e) => e.id), [dX2.id], "Alpha's fills only")
    assert.equal(tDiesel[0].prevOdometerKm, 1000, "…with the previous reading of X's Beta fill")
    const ownerDiesel = await read(OWNER, () => api.diesel.list())
    assert.ok(ownerDiesel.some((e) => e.id === dX1.id) && !("prevOdometerKm" in ownerDiesel[0]), "the Owner's list is unchanged")
    const dsOf = async (id: RequestIdentity, diesel: DieselEntry[]) => ({ vehicles: await call(id, "vehicles.list"), drivers: [], diesel, trips: [], customers: await call(id, "customers.list"), assignments: await call(id, "assignments.list") }) as never
    const ownerDs = { vehicles: await read(OWNER, () => api.vehicles.list()), drivers: [], diesel: ownerDiesel, trips: [], customers: await read(OWNER, () => api.customers.list()), assignments: await read(OWNER, () => api.assignments.list()) } as never
    assert.equal(fillRow(buildDieselIndex(await dsOf(TATA, tDiesel)), tDiesel[0]).kmSince, 400, "KM Run across the transfer: 1,400 − 1,000")
    assert.equal(fillRow(buildDieselIndex(ownerDs), ownerDiesel.find((e) => e.id === dX2.id)!).kmSince, 400, "…the same as the Owner's")
    // AdBlue (owner, 12 Nov 2026): every customer's entries, granted or not, all dates — exactly the Owner's list.
    const tAdblue = await call<AdBlueEntry[]>(TATA, "adblue.list")
    const ownerAdblue = await read(OWNER, () => api.adblue.list())
    assert.deepEqual(tAdblue, ownerAdblue, "Tata Adblue: every AdBlue entry, as the Owner sees it")
    assert.ok(tAdblue.some((e) => e.id === aB.id && e.customerId === beta.id) && tAdblue.some((e) => e.id === aX2.id), "…Beta's (not granted) and Alpha's")
    assert.equal(withRuns(tAdblue).find((e) => e.id === aX2.id)!.kmRun, 400, "AdBlue KM Run from X's Beta entry")
    const tRegs = await call<{ id: string; regNo: string }[]>(TATA, "adblueVehicles.list")
    assert.ok(["TN70PB0002", "TN70PX0003"].every((r) => tRegs.some((v) => v.regNo === r)) && !tRegs.some((v) => v.regNo === "TN70PA0001"), "the registrations of the vehicles with AdBlue (Beta's too; vA has none yet)")
    assert.ok(tRegs.every((v) => Object.keys(v).sort().join() === "id,regNo"), "…id and number only — no other vehicle detail")
    // The shared stock: every purchase; the draws only as company-wide totals by month (owner, 11 Nov 2026).
    const tPurchases = await call<AdBluePurchase[]>(TATA, "adbluePurchases.list")
    assert.deepEqual(tPurchases, await read(OWNER, () => api.adbluePurchases.list()))
    for (const id of [TATA, ADB]) assert.equal((await call<unknown[]>(id, "adblueStock.list")).length, stockDraws(ownerAdblue).length, `${id.role}: every draw on the shared stock`)
    // A direct vendor purchase for Beta (not granted): in the company-wide totals, never in Tata Adblue's entries.
    const bDirect = await as(OWNER, () => api.adblue.create({ ...ab(vB.id, beta.id, today, 600, 2), source: "DIRECT", vendorName: "Beta Vendor", rate: 100, paymentMode: "CASH" }))
    const ownerTotals = await read(OWNER, () => api.adblueTotals.get())
    const tTotals = await call<AdBlueTotals>(TATA, "adblueTotals.get")
    assert.deepEqual(tTotals, ownerTotals, "Tata Adblue: the whole company's AdBlue totals, exactly the Owner's")
    for (const id of [ADB, DEV, EMP]) assert.deepEqual(await call(id, "adblueTotals.get"), ownerTotals, `${id.role}: the same totals`)
    const allAdblue = await read(OWNER, () => api.adblue.list())
    const allDraws = stockDraws(allAdblue)
    assert.equal(stockFor(tTotals.ledger).consumed, round2(allDraws.reduce((t, e) => t + e.quantityLitres, 0)), "Consumed: every customer's draws (Beta's too)")
    assert.equal(stockFor(tTotals.ledger).consumedCost, round2(allDraws.reduce((t, e) => t + e.amount, 0)), "…at cost")
    const ownerValue = valueInventory(tPurchases, allDraws)
    assert.deepEqual(tTotals.current, { stockLitres: ownerValue.stockLitres, stockValue: ownerValue.stockValue, avgRate: ownerValue.avgRate }, "stock and value: company-wide, exact")
    assert.deepEqual(tTotals.direct, [{ month: today.slice(0, 7), litres: 2, cost: 200, count: 1 }], "direct purchases: company-wide totals (Beta's)")
    assert.ok((await call<AdBlueEntry[]>(TATA, "adblue.list")).some((e) => e.id === bDirect.id), "…and Beta's entry itself (AdBlue is company-wide to view)")
    assert.deepEqual(Object.keys(tTotals).sort(), ["current", "direct", "ledger", "monthEnd"])
    const totalsJson = JSON.stringify(tTotals)
    for (const x of [beta.id, alpha.id, vB.id, vX.id, vA.id, aB.id, aX2.id, bDirect.id, "BETA", "TN70PB0002", "Beta Vendor", '"id"', '"date"', "vehicleId", "customerId", "createdAt"])
      assert.ok(!totalsJson.includes(x), `the totals hold no ${x} — no record of any customer, vehicle or entry`)
    await as(OWNER, () => api.adblue.remove(bDirect.id, "Check cleanup"))
    for (const m of ["trips.list", "invoices.list", "payments.list", "tankerLoads.list", "tankerDispenses.list", "tankerTransfers.list", "tankerAdjustments.list", "audit.editedIds"])
      for (const id of [TATA, ADB]) assert.deepEqual(await call(id, m), [], `${id.role}: ${m} is empty`)
    for (const id of [TATA, ADB]) assert.equal(await call(id, "audit.unreviewedDeletions"), 0, `${id.role}: no deletion badge`)
    assert.ok((await call<{ openingBalance?: number }[]>(TATA, "fuelStations.list")).every((x) => x.openingBalance === undefined), "no station money")
    // Adblue: every customer and every record, as the Owner reads them.
    assert.deepEqual((await call<Customer[]>(ADB, "customers.list")).map((c) => c.id), (await read(OWNER, () => api.customers.list())).map((c) => c.id))
    assert.deepEqual(await call(ADB, "diesel.list"), ownerDiesel)
    assert.deepEqual(await call(ADB, "adblue.list"), ownerAdblue)
    // Straight from the database: no audit trail, no payments (the AdBlue profiles can't reach these anyway — not exposed).
    for (const id of [TATA, ADB]) {
      assert.deepEqual(await rowsAs(id, `select id from audit.events`), [], `${id.role} reads no audit events`)
      assert.deepEqual(await rowsAs(id, `select id from finance.payments`), [], `${id.role} reads no payments`)
    }
    assert.ok((await rowsAs(EMP, `select id from audit.events`)).length > 0 && (await rowsAs(EMP, `select id from finance.payments`)).length > 0, "the Employee still reads both")

    // Writes: Tata Adblue — AdBlue entries of Alpha's vehicles only; bulk purchases into the shared stock.
    const tNew = await call<AdBlueEntry>(TATA, "adblue.create", ab(vA.id, alpha.id, today, 2000, 2))
    assert.equal(tNew.customerId, alpha.id)
    await call(TATA, "adblue.update", tNew.id, ab(vA.id, alpha.id, today, 2000, 3), "Wrong litres")
    await assert.rejects(call(TATA, "adblue.remove", tNew.id, "Entered twice"), /refused by the method list/, "Tata Adblue deletes nothing (16 Nov 2026)")
    await as(OWNER, () => api.adblue.remove(tNew.id, "Entered twice")) // the Owner deletes it
    const tEvents = (await read(DEV, () => api.audit.list())).filter((e) => e.recordId === tNew.id)
    assert.deepEqual(tEvents.map((e) => [e.action, e.actor.role, e.actor.userId]).sort(), [["CREATED", "TATA_ADBLUE", P.TATA], ["DELETED", "OWNER", P.OWNER], ["UPDATED", "TATA_ADBLUE", P.TATA]], "audited as Tata Adblue; the deletion as the Owner")
    assert.equal(tEvents.find((e) => e.action === "DELETED")!.reason, "Entered twice")
    /** The events of one record: the actor, the vehicle / customer in the snapshots, the litres, a server timestamp. */
    const snapshotsOf = (events: AuditEvent[]) =>
      Object.fromEntries(events.map((e) => [e.action, { name: e.actor.name, before: e.before && [e.before.vehicleId, e.before.customerId, e.before.quantityLitres], after: e.after && [e.after.vehicleId, e.after.customerId, e.after.quantityLitres], date: e.recordDate, reason: e.reason, at: Math.abs(Date.now() - Date.parse(e.at)) < 3_600_000 }]))
    assert.deepEqual(snapshotsOf(tEvents), {
      CREATED: { name: "Tata Person", before: null, after: [vA.id, alpha.id, 2], date: today, reason: null, at: true },
      UPDATED: { name: "Tata Person", before: [vA.id, alpha.id, 2], after: [vA.id, alpha.id, 3], date: today, reason: "Wrong litres", at: true },
      DELETED: { name: "Owner Person", before: [vA.id, alpha.id, 3], after: null, date: today, reason: "Entered twice", at: true },
    }, "Tata Adblue's events: who, which vehicle and customer, before and after")
    const tUpd = tEvents.find((e) => e.action === "UPDATED")!
    assert.ok(tUpd.changes.some((c) => c.field === "quantityLitres" && c.before === 2 && c.after === 3) && !tUpd.changes.some((c) => c.field === "vehicleId" || c.field === "customerId"), "the change: litres only")
    assert.ok(tEvents.every((e) => e.label.startsWith("TN70PA0001 · ") && e.module === "AdBlue" && e.recordType === "AdBlue entry"), "labelled with the vehicle")
    // The Owner and the Employee read them in the Audit Log and the record's history, the same events Dev reads.
    for (const id of [OWNER, EMP]) {
      assert.deepEqual((await read(id, () => api.audit.list())).filter((e) => e.recordId === tNew.id), tEvents, `${id.role} reads Tata Adblue's events`)
      assert.equal((await read(id, () => api.audit.history(tNew.id))).length, 3, `${id.role}: the record's history`)
    }

    // A date change can't move an entry into another customer's assignment period — for every role (X: Beta until day 7, Alpha from day 6).
    const aX2Before = (await read(OWNER, () => api.adblue.list())).find((e) => e.id === aX2.id)
    for (const id of [TATA, ADB, OWNER, DEV, EMP])
      await assert.rejects(call(id, "adblue.update", aX2.id, ab(vX.id, alpha.id, day(7), 1400, 4), "Wrong date"), /worked for a different customer on .*Changing the date can't move this entry/, `${id.role}: into Beta's period, refused`)
    assert.deepEqual(((await read(OWNER, () => api.adblue.list())).find((e) => e.id === aX2.id)!), aX2Before, "the entry is unchanged, still Alpha's")
    assert.ok(!(await read(DEV, () => api.audit.list())).some((e) => e.recordId === aX2.id && e.action === "UPDATED"), "refused: nothing recorded")
    const tMove = await call<AdBlueEntry>(TATA, "adblue.create", ab(vA.id, alpha.id, today, 2000, 1))
    const moveTo = day(1) >= `${today.slice(0, 7)}-01` ? day(1) : today
    assert.equal((await call<AdBlueEntry>(TATA, "adblue.update", tMove.id, ab(vA.id, alpha.id, moveTo, 2000, 1), "Wrong date")).date, moveTo, "a date inside the same assignment: allowed")

    // Locked month: neither profile edits or deletes an entry in it (here the current month, locked by the Owner).
    const aMove = await call<AdBlueEntry>(ADB, "adblue.create", ab(vB.id, beta.id, today, 900, 1))
    await as(OWNER, () => api.monthLocks.set(today.slice(0, 7), "LOCKED"))
    for (const [id, e, v, c] of [[TATA, tMove, vA, alpha], [ADB, aMove, vB, beta]] as const) {
      await assert.rejects(call(id, "adblue.update", e.id, ab(v.id, c.id, e.date, e.closingKm, 2), "Change in a locked month"), /is locked/, `${id.role}: no edit in a locked month`)
      await assert.rejects(call(id, "adblue.remove", e.id, "Delete in a locked month"), /refused by the method list/, `${id.role}: no delete at all`)
      await sqlAs(id, `update fuel.adblue_entries set quantity_litres = 9 where id = '${e.id}'; delete from fuel.adblue_entries where id = '${e.id}';`) // RLS: month_open
      assert.equal((await read(OWNER, () => api.adblue.list())).find((x) => x.id === e.id)!.quantityLitres, 1, `${id.role}: untouched, also straight in the database`)
    }
    await as(DEV, () => api.monthLocks.set(today.slice(0, 7), "OPEN"))
    await as(OWNER, () => api.adblue.remove(tMove.id, "Lock check cleanup"))
    await as(OWNER, () => api.adblue.remove(aMove.id, "Lock check cleanup"))
    await assert.rejects(call(TATA, "adblue.create", ab(vB.id, beta.id, today, 900, 1)), /for this customer/, "Beta's vehicle: refused")
    await assert.rejects(call(TATA, "adblue.create", ab(vB.id, alpha.id, today, 900, 1)), /assigned to BETA/, "…and its customer can't be chosen around")
    await assert.rejects(call(TATA, "adblue.update", aB.id, ab(vB.id, beta.id, day(5), 500, 1)), /for this customer/)
    await assert.rejects(call(TATA, "adblue.remove", aB.id, "Not mine"), /refused by the method list/)
    await assert.rejects(call(TATA, "adblue.create", ab(vA.id, alpha.id, "2026-10-31", 1500, 1)), /October 2026 is locked/, "the month lock applies")
    const bulk = { date: today, vendorName: "Tata Bulk Vendor", product: "AdBlue", buckets: 2, litresPerBucket: 20, pricePerBucket: 900, invoiceNo: "", notes: "" }
    await assert.rejects(call(TATA, "adbluePurchases.create", bulk), /can't change the AdBlue vendor list/, "an unknown vendor: the profiles never add one")
    await as(OWNER, () => api.adblueVendors.create({ name: "Tata Bulk Vendor", defaultRate: 45 }))
    const tBulk = await call<AdBluePurchase>(TATA, "adbluePurchases.create", bulk)
    assert.equal((await read(OWNER, () => api.adbluePurchases.list())).find((x) => x.id === tBulk.id)!.totalLitres, 40, "into the one shared stock")
    // RLS, even if the server's checks were bypassed: Beta's entries, Diesel, purchases and opening stock stay closed.
    const evSql = (id: string, action = "CREATED") => `insert into audit.events (actor_kind, actor_user_id, actor_role, action, module, record_type, record_id) values ('SESSION', private.current_profile_id(), private.erp_role(), '${action}', 'AdBlue', 'AdBlue entry', '${id}');`
    await assert.rejects(sqlAs(TATA, `insert into fuel.adblue_entries (id, vehicle_id, customer_id, date, closing_km, quantity_litres, before_vendor_tracking) values ('adb_rls1', '${vB.id}', '${beta.id}', '${today}', 950, 1, false); ${evSql("adb_rls1")}`), /row-level security/, "RLS: an ungranted customer")
    await sqlAs(TATA, `insert into fuel.adblue_entries (id, vehicle_id, customer_id, date, closing_km, quantity_litres, before_vendor_tracking) values ('adb_rls2', '${vA.id}', '${alpha.id}', '${today}', 2100, 1, false); ${evSql("adb_rls2")}`)
    await sqlAs(TATA, `update fuel.adblue_entries set notes = 'tampered' where id = '${aB.id}'; delete from fuel.adblue_entries where id = '${aB.id}'; update fuel.adblue_purchases set notes = 'tampered'; delete from fuel.adblue_purchases where opening;`)
    assert.equal((await read(OWNER, () => api.adblue.list())).find((e) => e.id === aB.id)!.notes, "", "RLS: Beta's entry untouched")
    assert.ok((await read(OWNER, () => api.adbluePurchases.list())).every((x) => x.notes !== "tampered") && (await read(OWNER, () => api.adbluePurchases.list())).some((x) => x.opening), "RLS: purchases and opening stock untouched")
    await assert.rejects(sqlAs(TATA, `insert into fuel.adblue_purchases (date, vendor_name, product, buckets, litres_per_bucket, price_per_bucket, opening) values ('${today}', '', 'Opening', 1, 10, 10, true)`), /row-level security/, "RLS: no opening stock")
    // Deleting (16 Nov 2026): not even the profile's own granted entry, straight in the database; and no vendor master writes.
    await sqlAs(TATA, `delete from fuel.adblue_entries where id = 'adb_rls2'`)
    assert.ok((await read(OWNER, () => api.adblue.list())).some((e) => e.id === "adb_rls2"), "RLS: Tata Adblue deletes nothing, its own entry included")
    await assert.rejects(sqlAs(TATA, `delete from fuel.adblue_entries where id = 'adb_rls2'; ${evSql("adb_rls2", "DELETED")}`), /row-level security|reason|check constraint/, "…and writes no deletion event")
    for (const id of [TATA, ADB]) await assert.rejects(sqlAs(id, `insert into fuel.adblue_vendors (name) values ('Profile Vendor'); insert into audit.events (actor_kind, actor_user_id, actor_role, action, module, record_type, record_id) values ('SESSION', private.current_profile_id(), private.erp_role(), 'CREATED', 'AdBlue', 'AdBlue vendor', 'x');`), /row-level security/, `RLS: ${id.role} adds no vendor`)
    await assert.rejects(sqlAs(ADB, `insert into fuel.diesel_entries (company_code, date, vehicle_id, station_id, litres, rate, odometer_km) values ('VT', '${today}', '${vA.id}', '${station.id}', 5, 95, 2500)`), /row-level security/, "RLS: no Diesel writes")
    await assert.rejects(sqlAs(TATA, `insert into fuel.tanker_adjustments (date, tanker_id, litres, reason) values ('${today}', '${JIO}', 1, 'x')`), /row-level security/)
    await sqlAs(ADB, `update fuel.diesel_entries set litres = 1; delete from fuel.diesel_entries; update core.customers set notes = 'x'`)
    assert.deepEqual(await read(OWNER, () => api.diesel.list()), ownerDiesel, "RLS: every Diesel row untouched")
    // Master data (owner, 11 Nov 2026: the profiles use existing records, never manage them). Through /api/erp every
    // master-data, Diesel and payment write is off the method list; straight in the database (the server bypassed), RLS
    // refuses every insert and no update or delete changes a row — customers, vehicles, drivers, assignments, status
    // history, vehicle types, fuel stations, tankers, Diesel entries.
    for (const m of ["customers.create", "customers.update", "customers.archive", "customers.restore", "vehicles.create", "vehicles.update", "vehicles.archive", "vehicles.restore", "vehicles.transfer", "vehicles.setOpeningOdometer", "drivers.create", "drivers.update", "drivers.archive", "drivers.restore", "assignments.correctStartDate", "fuelStations.create", "fuelStations.update", "fuelStations.archive", "fuelStations.restore", "fuelStations.setOpeningBalance", "tankers.create", "tankers.update", "diesel.create", "diesel.update", "diesel.remove", "fuelStationPayments.create", "payments.create", "settings.update"])
      for (const id of [TATA, ADB]) await assert.rejects(call(id, m), /refused by the method list/, `${id.role}: ${m}`)
    const masters = ["core.customers", "core.vehicles", "core.drivers", "core.vehicle_assignments", "core.customer_status_periods", "core.vehicle_status_periods", "core.vehicle_types", "fuel.fuel_stations", "fuel.tankers", "fuel.diesel_entries"]
    const masterRows = async () => JSON.stringify(await Promise.all(masters.map(async (t) => (await db.query(`select * from ${t} order by 1`)).rows)))
    const mastersBefore = await masterRows()
    for (const id of [TATA, ADB])
      for (const t of masters) {
        const [schema, table] = t.split(".")
        const cols = (await db.query<{ c: string }>(`select column_name as c from information_schema.columns where table_schema = '${schema}' and table_name = '${table}' and is_generated = 'NEVER' order by ordinal_position`)).rows.map((r) => r.c)
        const copy = `(select to_jsonb(x) || '{"id": "rls_${id.role.toLowerCase()}"}' from ${t} x limit 1)`
        await assert.rejects(sqlAs(id, `insert into ${t} (${cols.join(", ")}) select ${cols.join(", ")} from jsonb_populate_record(null::${t}, ${copy})`), /row-level security/, `RLS: ${id.role} can't add to ${t}`)
        for (const stmt of [`update ${t} set ${cols[0]} = ${cols[0]}`, `delete from ${t}`]) await sqlAs(id, stmt).catch((e: Error) => assert.match(e.message, /permission denied|row-level security/, `${id.role}: ${stmt}`))
      }
    assert.equal(await masterRows(), mastersBefore, "RLS: every master-data and Diesel row untouched")
    // AdBlue entries only for vehicles that exist (nothing is created on the way); Tata Adblue never for a spare vehicle.
    await assert.rejects(call(ADB, "adblue.create", ab("veh_nope", alpha.id, today, 100, 1)), /Vehicle veh_nope not found/, "Adblue: an unknown vehicle is refused by the API")
    const vSpare = await veh("TN70PS0004", null as never)
    await assert.rejects(as(OWNER, () => api.adblue.create(ab(vSpare.id, "cus_nope", today, 100, 1))), /Customer cus_nope not found/, "an unknown customer is refused by the API (any role)")
    // Both profiles: only a vehicle assigned to a customer on the entry's date (owner, 11 Nov 2026) — never a spare
    // vehicle, a date after its assignment ended or before it began, whatever customer the request names. Owner, Dev
    // and Employee unchanged. (Months before today are opened for the check and closed again after it.)
    const months = [...new Set([day(9), today].map((d) => d.slice(0, 7)))].filter((m) => m < today.slice(0, 7))
    for (const m of months) await as(DEV, () => api.monthLocks.set(m, "OPEN"))
    const noAssignment = /has no customer assignment on .*Your account can add AdBlue only for a vehicle assigned to a customer on the entry date/
    for (const id of [ADB, TATA]) {
      await assert.rejects(call(id, "adblue.create", ab(vSpare.id, null as never, today, 100, 1)), noAssignment, `${id.role}: a spare vehicle, no customer`)
      await assert.rejects(call(id, "adblue.create", ab(vSpare.id, alpha.id, today, 100, 1)), noAssignment, `${id.role}: a spare vehicle, even naming a (granted) customer`)
    }
    // Expired: Alpha from day 9, unassigned from day 3.
    const vEnd = await veh("TN70PE0005", alpha.id)
    await as(OWNER, () => api.vehicles.transfer(vEnd.id, null, day(3), "Alpha contract ended"))
    for (const id of [ADB, TATA]) await assert.rejects(call(id, "adblue.create", ab(vEnd.id, alpha.id, day(2), 100, 1)), noAssignment, `${id.role}: after the assignment ended`)
    // Historical dates inside the assignment still work, back-dated, also for edits (the vehicle has no customer today).
    const eEnd = await call<AdBlueEntry>(ADB, "adblue.create", ab(vEnd.id, null as never, day(6), 100, 1))
    assert.equal(eEnd.customerId, alpha.id, "Adblue: back-dated into the assignment, stamped Alpha from it")
    assert.equal((await call<AdBlueEntry>(TATA, "adblue.update", eEnd.id, ab(vEnd.id, alpha.id, day(5), 100, 2), "Wrong date")).date, day(5), "Tata Adblue: an edit inside the assignment, allowed")
    for (const id of [ADB, TATA]) await assert.rejects(call(id, "adblue.update", eEnd.id, ab(vEnd.id, alpha.id, day(2), 100, 2), "Wrong date"), noAssignment, `${id.role}: an edit to a date after it ended, refused`)
    assert.equal((await read(OWNER, () => api.adblue.list())).find((e) => e.id === eEnd.id)!.date, day(5), "refused edits change nothing")
    // Not yet assigned: Alpha only from day 2.
    const vLate = await veh("TN70PF0006", alpha.id, day(2))
    for (const id of [ADB, TATA]) await assert.rejects(call(id, "adblue.create", ab(vLate.id, alpha.id, day(4), 100, 1)), noAssignment, `${id.role}: before the assignment began`)
    const eLate = await call<AdBlueEntry>(TATA, "adblue.create", ab(vLate.id, alpha.id, day(1), 100, 1))
    await assert.rejects(call(ADB, "adblue.update", eLate.id, ab(vLate.id, alpha.id, day(4), 100, 1), "Wrong date"), noAssignment, "Adblue: an edit to before the assignment, refused")
    // The Owner, Dev and Employee keep recording AdBlue for a spare vehicle and outside assignments, as before.
    const oSpare = await as(OWNER, () => api.adblue.create(ab(vSpare.id, null as never, today, 100, 1)))
    const dEnd = await as(DEV, () => api.adblue.create(ab(vEnd.id, null as never, day(2), 200, 1)))
    const mLate = await as(EMP, () => api.adblue.create(ab(vLate.id, null as never, day(4), 50, 1)))
    assert.deepEqual([oSpare.customerId, dEnd.customerId, mLate.customerId], [null, null, null], "Owner / Dev / Employee: unchanged")
    // Audit as before: the profiles' entries are recorded as them. They delete nothing (owner, 16 Nov 2026): the method
    // list refuses adblue.remove, the API refuses it, and RLS refuses it (below).
    const evs = await read(OWNER, () => api.audit.history(eEnd.id))
    assert.deepEqual(evs.map((e) => [e.action, e.actor.role]), [["CREATED", "ADBLUE"], ["UPDATED", "TATA_ADBLUE"]], "each recorded as the profile that did it")
    for (const [id, e] of [[TATA, eLate], [ADB, eEnd]] as const) {
      await assert.rejects(call(id, "adblue.remove", e.id, "Profile delete"), /refused by the method list/)
      await assert.rejects(as(id, () => api.adblue.remove(e.id, "Profile delete")), /can't delete AdBlue records/, "…and by the API itself")
    }
    for (const e of [eLate, eEnd, oSpare, dEnd, mLate]) await as(OWNER, () => api.adblue.remove(e.id, "Check cleanup"))
    for (const m of months) await as(DEV, () => api.monthLocks.set(m, "LOCKED"))

    // Diesel visibility with two granted customers (owner, 12 Nov 2026). Alpha and Gamma granted, Beta not; vehicle X
    // worked for Beta, then Alpha. Every read Tata Adblue can make — what every Diesel screen, search, filter, count and
    // card is built from — holds only Alpha's and Gamma's customers, vehicles and records: nothing names Beta, its vehicle,
    // X's Beta-period records or a vehicle that never worked for a granted customer. The AdBlue totals stay company-wide.
    const gamma = await mkCust("GAMMA")
    const vG = await veh("TN70PG0007", gamma.id)
    const dG = await as(OWNER, () => api.diesel.create(dfill(vG.id, gamma.id, day(4), 700)))
    await grant(DEV, P.TATA, [alpha.id, gamma.id], "Tata contract: Alpha and Gamma")
    const tReads = Object.fromEntries(await Promise.all(PROFILE_METHODS.filter((m) => isReadMethod(m.split(".")[0], m.split(".")[1])).map(async (m) => [m, await call<unknown>(TATA, m)] as const)))
    assert.deepEqual((tReads["customers.list"] as Customer[]).map((c) => c.id).sort(), [alpha.id, gamma.id].sort(), "two granted customers: exactly those two")
    const tFills = tReads["diesel.list"] as DieselEntry[]
    assert.ok(tFills.some((e) => e.id === dG.id) && tFills.some((e) => e.id === dX2.id) && tFills.every((e) => e.customerId === alpha.id || e.customerId === gamma.id), "Diesel: Alpha's and Gamma's fills only")
    const tIdx = buildDieselIndex({ customers: tReads["customers.list"], vehicles: tReads["vehicles.list"], drivers: tReads["drivers.list"], diesel: tFills, trips: [], assignments: tReads["assignments.list"] } as never)
    assert.deepEqual(tIdx.groups.map((g) => g.id).sort(), [alpha.id, gamma.id].sort(), "Diesel landing: only the granted customers' cards (no Beta, no Unallocated)")
    assert.deepEqual(tIdx.groups.find((g) => g.id === gamma.id)!.vehicleIds, [vG.id], "…each with its own vehicles")
    const hits = searchVehicles("TN70P", tReads["vehicles.list"] as never, tReads["assignments.list"] as never, today, today)
    assert.ok(hits.length > 0 && hits.every((h) => h.vehicle.id !== vB.id && h.vehicle.id !== vSpare.id), "vehicle search: never Beta's or another vehicle")
    // Every response but the AdBlue ones (company-wide to view since 12 Nov 2026): nothing names Beta or its vehicle.
    const adblueReads = ["adblue.list", "adblueStock.list", "adblueVehicles.list", "adblueTotals.get", "adbluePurchases.list"]
    const tJson = JSON.stringify(Object.entries(tReads).filter(([m]) => !adblueReads.includes(m)))
    for (const x of [beta.id, '"BETA"', vB.id, "TN70PB0002", vSpare.id, "TN70PS0004", dX1.id, aB.id])
      assert.ok(!tJson.includes(x), `no Tata Adblue Diesel / customer / vehicle response names ${x}`)
    assert.deepEqual(tReads["adblue.list"], await read(OWNER, () => api.adblue.list()), "AdBlue: every customer's entries")
    assert.deepEqual(tReads["adblueTotals.get"], await read(OWNER, () => api.adblueTotals.get()), "the company-wide AdBlue totals: unchanged (Beta's draws included)")
    // Adblue: every customer and company; the Owner, Dev and Employee: unchanged.
    assert.ok((await call<Customer[]>(ADB, "customers.list")).some((c) => c.id === beta.id), "Adblue: Beta too")
    for (const id of [OWNER, DEV, EMP]) {
      const cs = await call<Customer[]>(id, "customers.list")
      assert.ok([alpha.id, beta.id, gamma.id].every((c) => cs.some((x) => x.id === c)), `${id.role}: every customer`)
      assert.ok((await call<DieselEntry[]>(id, "diesel.list")).some((e) => e.id === dX1.id), `${id.role}: every fill`)
    }
    await grant(DEV, P.TATA, [alpha.id], "Gamma contract ended")
    assert.deepEqual((await call<Customer[]>(TATA, "customers.list")).map((c) => c.id), [alpha.id], "a revoked customer disappears at once")
    await as(OWNER, () => api.diesel.remove(dG.id, "Check cleanup"))

    // Industrial Diesel Supply (12 Nov 2026) on the shared database. The Owner, Dev and Employee as for Diesel; the AdBlue
    // profiles read only (Tata Adblue its granted customers'); created_by / updated_by from the signed-in profile, never
    // the request; the amount computed by the database; one audit event per change; RLS refuses the profiles' writes,
    // a customer change and the Employee's closed month; vehicle Diesel untouched. The diesel comes out of the tankers:
    // each allocation is a movement of the one tanker stock (fuel.tanker_movements), locked and checked at COMMIT.
    const dieselBefore = await read(OWNER, () => api.diesel.list())
    const tk = async (name: string, regNo: string, litres: number) => {
      const t = await as(OWNER, () => api.tankers.create({ name, regNo, vehicleId: null, capacityLitres: null, notes: "" }))
      await as(OWNER, () => api.tankerLoads.create({ tankerId: t.id, date: today, stationId: station.id, litres, rate: 90, invoiceNo: "", notes: "" }))
      return t.id
    }
    const TA = await tk("Industrial A", "KA01IND0001", 1000)
    const TB = await tk("Industrial B", "KA01IND0002", 500)
    const dbStock = async (t: string) => Number((await db.query<{ s: string }>(`select coalesce(sum(litres), 0)::text as s from fuel.tanker_movements where tanker_id = '${t}'`)).rows[0].s)
    const allocRows = async (id: string) => (await db.query<{ tanker_id: string; litres: string }>(`select tanker_id, litres::text from fuel.industrial_supply_allocations where supply_id = '${id}' order by tanker_id collate "C"`)).rows
    const supply = (customerId: string, date: string, litres: number, rate: number, allocations: { tankerId: string; litres: number }[]) => ({ customerId, date, litres, rate, purpose: "Generator operation", remarks: "", allocations })
    const iA = await call<IndustrialSupply>(OWNER, "industrialSupplies.create", supply(alpha.id, today, 250.5, 96.25, [{ tankerId: TA, litres: 150.5 }, { tankerId: TB, litres: 100 }]))
    const iB = await call<IndustrialSupply>(EMP, "industrialSupplies.create", supply(beta.id, today, 100, 95, [{ tankerId: TA, litres: 100 }]))
    assert.deepEqual([await dbStock(TA), await dbStock(TB)], [1000 - 150.5 - 100, 500 - 100], "the database's tanker stock: lowered by each allocation")
    assert.equal((await db.query(`select 1 from fuel.tanker_movements where kind = 'INDUSTRIAL' and id = '${iA.id}'`)).rows.length, 2, "one INDUSTRIAL movement per tanker")
    const rowOf = async (id: string) => (await db.query<{ amount: string; created_by: string | null; updated_by: string | null }>(`select amount::text, created_by::text, updated_by::text from fuel.industrial_supplies where id = '${id}'`)).rows[0]
    assert.deepEqual(await rowOf(iA.id), { amount: "24110.63", created_by: P.OWNER, updated_by: P.OWNER }, "amount by the database; created by the Owner's profile")
    assert.deepEqual([iA.amount, iA.createdBy, iB.createdBy], [24110.63, P.OWNER, P.EMP])
    // Edit: change the tankers and the split — the original litres back, the new ones out, one transaction.
    const iA2 = await call<IndustrialSupply>(EMP, "industrialSupplies.update", iA.id, supply(alpha.id, today, 250.5, 97, [{ tankerId: TA, litres: 250.5 }]), "All from tanker A")
    assert.deepEqual([iA2.amount, (await rowOf(iA.id)).created_by, (await rowOf(iA.id)).updated_by], [24298.5, P.OWNER, P.EMP], "edited by the Employee: created_by kept, updated_by stamped")
    assert.deepEqual(await allocRows(iA.id), [{ tanker_id: TA, litres: "250.500" }], "allocations replaced")
    assert.deepEqual([await dbStock(TA), await dbStock(TB)], [1000 - 250.5 - 100, 500], "B gets its 100 L back; A gives 250.5 L")
    // Only the split changes (same litres, rate, date): the row is still touched — a new version, updated_by stamped.
    const v0 = (await db.query<{ v: string }>(`select updated_at::text as v from fuel.industrial_supplies where id = '${iA.id}'`)).rows[0].v
    await call(OWNER, "industrialSupplies.update", iA.id, supply(alpha.id, today, 250.5, 97, [{ tankerId: TA, litres: 200.5 }, { tankerId: TB, litres: 50 }]), "Split corrected")
    const v1 = (await db.query<{ v: string }>(`select updated_at::text as v from fuel.industrial_supplies where id = '${iA.id}'`)).rows[0].v
    assert.ok(v1 !== v0 && (await rowOf(iA.id)).updated_by === P.OWNER, "allocation-only edit: new version, updated by the Owner")
    assert.deepEqual([await dbStock(TA), await dbStock(TB)], [1000 - 200.5 - 100, 450])
    await call(OWNER, "industrialSupplies.update", iA.id, supply(alpha.id, today, 250.5, 97, [{ tankerId: TA, litres: 250.5 }]), "Back to all from A")
    await assert.rejects(call(OWNER, "industrialSupplies.update", iA.id, supply(alpha.id, today, 250.5, 97, [{ tankerId: TB, litres: 600 }]), "Too much"), /must add up|Insufficient/, "refused edits…")
    await assert.rejects(call(OWNER, "industrialSupplies.update", iA.id, supply(alpha.id, today, 700, 97, [{ tankerId: TB, litres: 700 }]), "Too much"), /Insufficient tanker inventory in Industrial B\. Available: 500 L/)
    assert.deepEqual(await allocRows(iA.id), [{ tanker_id: TA, litres: "250.500" }], "…change nothing")
    const iEv = (await read(DEV, () => api.audit.history(iA.id))).map((e) => [e.action, e.actor.role, e.reason ?? null, e.before?.allocations ?? null, e.after?.allocations ?? null])
    const firstSplit = [{ tankerId: TA, litres: 150.5 }, { tankerId: TB, litres: 100 }].sort((a, b) => (a.tankerId < b.tankerId ? -1 : 1))
    assert.deepEqual(iEv.slice(0, 2), [
      ["CREATED", "OWNER", null, null, firstSplit],
      ["UPDATED", "EMPLOYEE", "All from tanker A", firstSplit, [{ tankerId: TA, litres: 250.5 }]],
    ], "audited as who did it, with the reason and the previous / new tanker allocations")
    await assert.rejects(call(OWNER, "industrialSupplies.update", iA.id, supply(alpha.id, today, 1, 1, [{ tankerId: TA, litres: 1 }]), ""), /reason/, "an edit needs a reason")
    // Reads: Tata Adblue (Alpha granted) sees Alpha's only — through the method list and straight in the database; Adblue every customer's.
    assert.deepEqual((await call<IndustrialSupply[]>(TATA, "industrialSupplies.list")).map((x) => x.id), [iA.id], "Tata Adblue: its granted customer's supplies only")
    assert.deepEqual((await rowsAs<{ id: string }>(TATA, `select id from fuel.industrial_supplies`)).map((r) => r.id), [iA.id], "…RLS too")
    assert.deepEqual((await rowsAs<{ supply_id: string }>(TATA, `select supply_id from fuel.industrial_supply_allocations`)).map((r) => r.supply_id), [iA.id], "…and only its allocations")
    assert.deepEqual((await call<IndustrialSupply[]>(ADB, "industrialSupplies.list")).map((x) => x.id).sort(), [iA.id, iB.id].sort(), "Adblue: every customer's")
    // Writes: refused to both profiles by the method list and by RLS (supplies and allocations).
    const allocsBefore = JSON.stringify((await db.query(`select * from fuel.industrial_supply_allocations order by 1, 2`)).rows)
    for (const id of [TATA, ADB]) {
      for (const m of ["industrialSupplies.create", "industrialSupplies.update", "industrialSupplies.remove"]) await assert.rejects(call(id, m, supply(alpha.id, today, 1, 1, [{ tankerId: TA, litres: 1 }])), /refused by the method list/, `${id.role}: ${m}`)
      await assert.rejects(sqlAs(id, `insert into fuel.industrial_supplies (customer_id, date, litres, rate, purpose) values ('${alpha.id}', '${today}', 1, 1, 'Factory operations'); insert into audit.events (actor_kind, actor_user_id, actor_role, action, module, record_type, record_id) values ('SESSION', private.current_profile_id(), private.erp_role(), 'CREATED', 'Diesel', 'Industrial supply', 'x')`), /row-level security/, `RLS: ${id.role} adds no supply`)
      await assert.rejects(sqlAs(id, `insert into fuel.industrial_supply_allocations (supply_id, tanker_id, litres) values ('${iA.id}', '${TB}', 1)`), /row-level security|permission denied/, `RLS: ${id.role} adds no allocation`)
      await sqlAs(id, `update fuel.industrial_supplies set rate = 1; delete from fuel.industrial_supplies; delete from fuel.industrial_supply_allocations`)
    }
    assert.deepEqual([(await rowOf(iA.id)).amount, !!(await rowOf(iB.id)), JSON.stringify((await db.query(`select * from fuel.industrial_supply_allocations order by 1, 2`)).rows)], ["24298.50", true, allocsBefore], "RLS: the profiles change and delete nothing")
    // The database's own rules, even past the API.
    const ev = (id: string, action = "CREATED") => `insert into audit.events (actor_kind, actor_user_id, actor_role, action, module, record_type, record_id) values ('SESSION', private.current_profile_id(), private.erp_role(), '${action}', 'Diesel', 'Industrial supply', '${id}');`
    const raw = (id: string, litres: number, allocs: [string, number][], date = today) =>
      `insert into fuel.industrial_supplies (id, customer_id, date, litres, rate, purpose) values ('${id}', '${alpha.id}', '${date}', ${litres}, 90, 'Factory operations'); ${allocs.map(([t, l]) => `insert into fuel.industrial_supply_allocations (supply_id, tanker_id, litres) values ('${id}', '${t}', ${l});`).join(" ")} ${ev(id)}`
    await assert.rejects(sqlAs(OWNER, raw("ind_db1", 900, [[TB, 900]])), /Insufficient tanker inventory in Industrial B\. Available: 500\.00 L/, "never beyond a tanker's stock (database)")
    await assert.rejects(sqlAs(OWNER, raw("ind_db2", 500, [[TA, 100], [TB, 450]])), /must add up|Insufficient/, "one allocation fails: nothing is saved")
    assert.equal((await db.query(`select 1 from fuel.industrial_supplies where id in ('ind_db1', 'ind_db2')`)).rows.length, 0, "…rolled back, supply and allocations")
    await assert.rejects(sqlAs(OWNER, raw("ind_db3", 10, [[TA, 9]])), /must add up to the quantity supplied/, "allocations must add up (database)")
    await assert.rejects(sqlAs(OWNER, raw("ind_db4", 10, [])), /must add up to the quantity supplied \(10/, "no allocation at all (database)")
    await sqlAs(OWNER, raw("ind_db5", 10, [[TB, 10]]))
    await assert.rejects(sqlAs(OWNER, `update fuel.industrial_supplies set date = '${day(1)}' where id = 'ind_db5'; ${ev("ind_db5", "UPDATED")}`), /Insufficient tanker inventory in Industrial B/, "moved before the tanker's load: refused at COMMIT")
    await assert.rejects(sqlAs(OWNER, `delete from fuel.industrial_supply_allocations where supply_id = 'ind_db5'; ${ev("ind_db5", "UPDATED")}`), /must add up/, "its allocations can't just vanish")
    await sqlAs(OWNER, `delete from fuel.industrial_supplies where id = 'ind_db5'; ${ev("ind_db5", "DELETED")}`)
    assert.deepEqual([await allocRows("ind_db5"), await dbStock(TB)], [[], 500], "deleting the supply deletes its allocations: the litres back once")
    await assert.rejects(db.exec(`update fuel.industrial_supplies set customer_id = '${beta.id}' where id = '${iA.id}'`), /can't be moved to another customer/, "never moved to another customer")
    await assert.rejects(sqlAs(OWNER, `insert into fuel.industrial_supplies (customer_id, date, litres, rate, purpose) values ('${alpha.id}', '${today}', 1, 1, 'Factory operations')`), /no audit event|must add up/, "no supply without its audit event")
    await assert.rejects(sqlAs(OWNER, `insert into fuel.industrial_supplies (customer_id, date, litres, rate, purpose) values ('${alpha.id}', '${today}', -1, 1, 'x')`), /check constraint|violates/, "no negative litres")
    await assert.rejects(sqlAs(OWNER, `insert into fuel.industrial_supplies (customer_id, date, litres, rate, purpose) values ('${alpha.id}', '${today}', 1, 1, 'Other')`), /check constraint|violates/, "Other must be described")
    // Month lock: last month is closed to the Employee (API and RLS), open to the Owner.
    const lastMonth = new Date(Date.parse(`${today.slice(0, 7)}-01`) - 86_400_000).toISOString().slice(0, 10)
    await assert.rejects(call(EMP, "industrialSupplies.create", supply(alpha.id, lastMonth, 5, 95, [{ tankerId: JIO, litres: 5 }])), /is locked/, "Employee: closed month refused")
    await assert.rejects(sqlAs(EMP, `insert into fuel.industrial_supplies (customer_id, date, litres, rate, purpose) values ('${alpha.id}', '${lastMonth}', 5, 95, 'Factory operations')`), /row-level security/, "…by RLS too")
    // Delete through the API: the litres back to every tanker, once.
    await call(OWNER, "industrialSupplies.remove", iA.id, "Check cleanup")
    await call(OWNER, "industrialSupplies.remove", iA.id, "Check cleanup") // a second delete finds nothing
    await call(OWNER, "industrialSupplies.remove", iB.id, "Check cleanup")
    assert.deepEqual([await dbStock(TA), await dbStock(TB), (await db.query(`select 1 from fuel.industrial_supply_allocations`)).rows.length], [1000, 500, 0], "every litre back, exactly once")
    assert.deepEqual(await read(OWNER, () => api.diesel.list()), dieselBefore, "vehicle Diesel untouched")
    // Diesel: a date change can't move a fill into another customer's assignment period either — Owner, Dev, Employee
    // (X: Beta until day 7, Alpha from day 6). Refused = no change, no event; inside the same period it still works.
    const dEdit = (e: DieselEntry, date: string) => ({ date, vendorId: e.vendorId, litres: e.litres, rate: e.rate, odometerKm: e.odometerKm, billNo: e.billNo, paymentMode: e.paymentMode, tankerId: e.tankerId })
    const eventCount = async () => (await read(DEV, () => api.audit.list())).length
    const events0 = await eventCount()
    for (const id of [OWNER, DEV, EMP]) {
      await assert.rejects(as(id, () => api.diesel.update(dX2.id, dEdit(dX2, day(7)), "Wrong date")), /TN70PX0003 worked for a different customer on .*Changing the date can't move this entry/, `${id.role}: Alpha's fill into Beta's period, refused`)
      await assert.rejects(as(id, () => api.diesel.update(dX1.id, dEdit(dX1, day(5)), "Wrong date")), /worked for a different customer/, `${id.role}: Beta's fill into Alpha's period, refused`)
    }
    assert.deepEqual(await read(OWNER, () => api.diesel.list()), ownerDiesel, "refused: every fill unchanged, each still under its own customer")
    assert.equal(await eventCount(), events0, "refused: no audit event")
    const dIn = await as(OWNER, () => api.diesel.create(dfill(vA.id, alpha.id, today, 3000)))
    for (const [id, date] of [[OWNER, moveTo], [DEV, today], [EMP, moveTo]] as const) {
      await as(id, () => api.diesel.update(dIn.id, dEdit(dIn, date), "Wrong date"))
      const now = (await read(OWNER, () => api.diesel.list())).find((e) => e.id === dIn.id)!
      assert.deepEqual([now.date, now.customerId, now.litres, now.odometerKm], [date, alpha.id, 50, 3000], `${id.role}: a date inside the same assignment still works`)
    }
    const dInEvents = (await read(DEV, () => api.audit.list())).filter((e) => e.recordId === dIn.id && e.action === "UPDATED")
    assert.equal(dInEvents.length, moveTo === today ? 0 : 3, "one UPDATED event per real date change")
    assert.ok(dInEvents.every((e) => e.changes.some((c) => c.field === "date") && e.before?.customerId === alpha.id && e.after?.customerId === alpha.id), "…the date changed, the customer didn't")
    await as(OWNER, () => api.diesel.remove(dIn.id, "Date check cleanup"))
    await as(DEV, () => api.adblue.remove("adb_rls2", "RLS check cleanup"))
    // Adblue: every customer's entries; bulk purchases; Diesel refused.
    const aNew = await call<AdBlueEntry>(ADB, "adblue.create", ab(vB.id, beta.id, today, 900, 1))
    await call(ADB, "adblue.update", aNew.id, ab(vB.id, beta.id, today, 900, 2), "Wrong litres")
    await assert.rejects(call(ADB, "adblue.remove", aNew.id, "Check cleanup"), /refused by the method list/, "Adblue deletes nothing (16 Nov 2026)")
    await as(DEV, () => api.adblue.remove(aNew.id, "Check cleanup"))
    const aEvents = (await read(DEV, () => api.audit.list())).filter((e) => e.recordId === aNew.id)
    assert.deepEqual(aEvents.map((e) => [e.action, e.actor.kind, e.actor.role, e.actor.userId]).sort(), [["CREATED", "SESSION", "ADBLUE", P.ADB], ["DELETED", "SESSION", "DEV", P.DEV], ["UPDATED", "SESSION", "ADBLUE", P.ADB]], "audited as Adblue, never another role; the deletion as Dev")
    assert.deepEqual(snapshotsOf(aEvents), {
      CREATED: { name: ADB.email, before: null, after: [vB.id, beta.id, 1], date: today, reason: null, at: true },
      UPDATED: { name: ADB.email, before: [vB.id, beta.id, 1], after: [vB.id, beta.id, 2], date: today, reason: "Wrong litres", at: true },
      DELETED: { name: "Dev Person", before: [vB.id, beta.id, 2], after: null, date: today, reason: "Check cleanup", at: true },
    }, "Adblue's events: who (no name → the signed-in email), which vehicle and customer, before and after")
    for (const id of [OWNER, EMP]) assert.deepEqual((await read(id, () => api.audit.list())).filter((e) => e.recordId === aNew.id), aEvents, `${id.role} reads Adblue's events`)
    for (const id of [TATA, ADB]) assert.deepEqual(await rowsAs(id, `select id from audit.events where record_id = '${aNew.id}'`), [], `${id.role} reads none of them`)
    await call(ADB, "adbluePurchases.create", { ...bulk, vendorName: "Tata Bulk Vendor" }) // an existing vendor
    await assert.rejects(as(ADB, () => api.diesel.create(dfill(vB.id, beta.id, today, 950))), /can't create fuel records/, "Diesel refused by the API itself too")

    // Live sync: module names only — AdBlue changes reach them, Payments never; the others unchanged.
    const c0 = await changesSince(transact as never, TATA, null)
    await as(OWNER, () => api.adblue.create(ab(vB.id, beta.id, today, 1000, 1)))
    await as(OWNER, () => api.payments.create(receipt(5, oldInv.id, 5)))
    const tSync = await changesSince(transact as never, TATA, c0.cursor)
    assert.ok(tSync.modules.includes("AdBlue") && !tSync.modules.includes("Payments") && !tSync.modules.includes("Accounts"), `Tata Adblue is told about AdBlue only: ${tSync.modules}`)
    assert.ok((await changesSince(transact as never, OWNER, c0.cursor)).modules.includes("Payments"), "the Owner is still told about receipts")

    // A role change away from Tata Adblue revokes every grant, each audited; switching back brings none back.
    await grant(DEV, P.TATA2, [alpha.id, beta.id], "Both customers")
    assert.deepEqual(await grants(P.TATA2), [alpha.id, beta.id].sort())
    await sqlAs(DEV, `select public.set_account_role('${P.TATA2}', 'ADBLUE', 'Now every customer')`)
    assert.deepEqual(await grants(P.TATA2), [], "grants revoked with the role")
    const revoked = (await db.query<{ note: string; access: string; actor_role: string }>(`select note, after ->> 'access' as access, actor_role::text from audit.events where record_type = 'Customer access' and record_id = '${P.TATA2}' and after ->> 'access' = 'Not granted'`)).rows
    assert.deepEqual(revoked.map((r) => [r.note, r.access, r.actor_role]), [["Revoked automatically: the role changed from TATA_ADBLUE to ADBLUE", "Not granted", "DEV"], ["Revoked automatically: the role changed from TATA_ADBLUE to ADBLUE", "Not granted", "DEV"]])
    await sqlAs(DEV, `select public.set_account_role('${P.TATA2}', 'TATA_ADBLUE', 'Back to Tata')`)
    assert.deepEqual(await call(TATA2, "customers.list"), [], "back to Tata Adblue: no old access comes back")
    // Revoking Tata Adblue's last customer leaves every record it made or saw exactly as it was.
    await grant(DEV, P.TATA, [], "Contract ended")
    assert.deepEqual(await call(TATA, "customers.list"), [])
    assert.deepEqual(await call(TATA, "diesel.list"), [], "no customer: no Diesel")
    assert.deepEqual(await call(TATA, "adblue.list"), await read(OWNER, () => api.adblue.list()), "AdBlue is still viewed company-wide (grants limit writes and Diesel only)")
    assert.ok((await read(OWNER, () => api.adblue.list())).some((e) => e.id === aX2.id), "history intact after revocation")
    await grant(DEV, P.TATA, [alpha.id], "Contract renewed") // left in place: the reset scripts below must handle a grant

    /* -------------------------------------------------------------- 12e. delete = Owner / Dev: rows an edit removes (owner, 16 Nov 2026) */
    // Legitimate edits by the Employee keep working through the engine (they remove child rows inside an audited edit).
    const epsilon = await mkCust("EPSILON")
    const routeRows = async () => (await db.query<{ route: string; rate: string }>(`select route, rate::text from core.customer_route_rates where customer_id = '${epsilon.id}' order by line_no`)).rows
    const r2 = { route: "R2", distanceKm: 20, rate: 250 }
    await as(EMP, () => api.customers.update(epsilon.id, { pricing: { ...epsilon.pricing, routes: [{ route: "R1", distanceKm: 10, rate: 100 }, { route: "R2", distanceKm: 20, rate: 200 }] } }))
    await as(EMP, () => api.customers.update(epsilon.id, { pricing: { ...epsilon.pricing, routes: [r2] } }))
    assert.deepEqual(await routeRows(), [{ route: "R2", rate: "250.00" }], "the Employee edits route rates (rows rewritten inside the audited customer edit)")
    await as(EMP, () => api.customers.update(epsilon.id, { pricing: { ...epsilon.pricing, rate: 1750, routes: [r2] } }))
    assert.equal(Number((await db.query<{ rate: string }>(`select rate::text from core.customer_pricing where customer_id = '${epsilon.id}'`)).rows[0].rate), 1750, "…and the price")
    const periods = async (t: string, col: string, id: string) => (await db.query<{ status: string; start: string; end: string | null }>(`select status::text, start_date::text as start, end_date::text as "end" from core.${t} where ${col} = '${id}' order by start_date`)).rows
    const vE = await veh("TN70PE0012", epsilon.id)
    for (const [kind, t, col, id] of [["customers", "customer_status_periods", "customer_id", epsilon.id], ["vehicles", "vehicle_status_periods", "vehicle_id", vE.id]] as const) {
      // History that began before today (records here are created today, when an archive just rewrites the one period).
      await db.exec(`begin; update core.${t} set start_date = '${day(9)}' where ${col} = '${id}'; insert into audit.events (actor_kind, action, module, record_type, record_id) values ('SYSTEM', 'UPDATED', '${kind === "customers" ? "Customers" : "Vehicles"}', 'Fixture', '${id}'); commit;`)
      const before = await periods(t, col, id)
      await (kind === "customers" ? as(EMP, () => api.customers.archive(id)) : as(EMP, () => api.vehicles.archive(id)))
      assert.equal((await periods(t, col, id)).length, before.length + 1, `${kind}: archived today`)
      await (kind === "customers" ? as(EMP, () => api.customers.restore(id)) : as(EMP, () => api.vehicles.restore(id)))
      assert.deepEqual(await periods(t, col, id), before, `${kind}: restored the same day — the Employee's same-day undo removes today's period`)
    }
    const assignmentsOf = async (id: string) => (await db.query<{ customer_id: string }>(`select customer_id from core.vehicle_assignments where vehicle_id = '${id}' order by start_date`)).rows.map((r) => r.customer_id)
    await as(EMP, () => api.vehicles.transfer(vE.id, beta.id, today, ""))
    assert.deepEqual(await assignmentsOf(vE.id), [epsilon.id, beta.id], "the Employee transfers (an assignment is closed and appended, never deleted)")
    const sup = await call<IndustrialSupply>(EMP, "industrialSupplies.create", supply(alpha.id, today, 10, 95, [{ tankerId: TA, litres: 10 }]))
    await call(EMP, "industrialSupplies.update", sup.id, supply(alpha.id, today, 10, 95, [{ tankerId: TB, litres: 6 }, { tankerId: TA, litres: 4 }]), "Split between tankers")
    await call(EMP, "industrialSupplies.update", sup.id, supply(alpha.id, today, 10, 95, [{ tankerId: TB, litres: 10 }]), "All from tanker B")
    assert.deepEqual(await allocRows(sup.id), [{ tanker_id: TB, litres: "10.000" }], "the Employee replaces a supply's tankers (allocation rows removed inside the audited supply edit)")
    const supplyId = sup.id
    // A vehicle's drivers, dated (21 Nov 2026): the Employee adds drivers (one back-dated), removes one added today (the
    // period is deleted — same-day undo, inside the audited vehicle edit), closes another on its last day and re-adds it
    // later (a second period). DL numbers stay on the driver; PUC saved and read back.
    type DP = { driver_id: string; start: string; end: string | null }
    const periodRows = async (id: string) => (await db.query<DP>(`select driver_id, start_date::text as start, end_date::text as "end" from core.vehicle_driver_periods where vehicle_id = '${id}' order by start_date, driver_id`)).rows
    const dRavi = await call<Driver>(EMP, "drivers.create", { name: "Ravi", phone: "", licenseNo: " tn70  20110001234 ", licenseValidTill: "", companyCode: "VT", status: "ACTIVE" })
    const dMani = await call<Driver>(EMP, "drivers.create", { name: "Mani", phone: "", licenseNo: "", licenseValidTill: "", companyCode: "VT", status: "ACTIVE" })
    assert.equal((await db.query<{ l: string }>(`select license_no as l from core.drivers where id = '${dRavi.id}'`)).rows[0].l, "TN70 20110001234", "the DL number is stored once, on the driver, cleaned")
    await assert.rejects(call(EMP, "drivers.update", dMani.id, { licenseNo: "TN70 20110001234" }), /already recorded for Ravi/, "one DL number, one driver")
    await call(EMP, "drivers.update", dMani.id, { licenseNo: "KA05 20190004321" })
    await call(EMP, "vehicles.addDriver", vE.id, dRavi.id, day(20))
    await call(EMP, "vehicles.addDriver", vE.id, dMani.id, today)
    assert.deepEqual(await periodRows(vE.id), [{ driver_id: dRavi.id, start: day(20), end: null }, { driver_id: dMani.id, start: today, end: null }], "the Employee adds two drivers, one back-dated")
    await call(EMP, "vehicles.removeDriver", vE.id, dMani.id, today)
    await call(EMP, "vehicles.removeDriver", vE.id, dRavi.id, day(5))
    await call(EMP, "vehicles.addDriver", vE.id, dRavi.id, day(2))
    assert.deepEqual(await periodRows(vE.id), [{ driver_id: dRavi.id, start: day(20), end: day(5) }, { driver_id: dRavi.id, start: day(2), end: null }], "same-day undo removes the period; a closed period stays as history; re-added = a second period")
    await call(EMP, "vehicles.update", vE.id, { pucValidTill: day(-30) })
    const vE2 = (await call<Vehicle[]>(EMP, "vehicles.list")).find((x) => x.id === vE.id)!
    assert.deepEqual([vE2.driverPeriods!.map((p) => [p.driverId, p.startDate, p.endDate]), vE2.pucValidTill], [[[dRavi.id, day(20), day(5)], [dRavi.id, day(2), null]], day(-30)], "driver periods and PUC read back through the engine")
    await assert.rejects(call(TATA, "vehicles.addDriver", vE.id, dMani.id, today), /refused by the method list/, "the AdBlue profiles can't change a vehicle's drivers")
    await assert.rejects(call(ADB, "vehicles.removeDriver", vE.id, dRavi.id, today), /refused by the method list/)
    // The database's own rules: one driver's periods never overlap; two drivers never share a DL number (blanks allowed).
    await assert.rejects(sqlAs(OWNER, `insert into core.vehicle_driver_periods (vehicle_id, driver_id, start_date) values ('${vE.id}', '${dRavi.id}', '${day(10)}'); insert into audit.events (actor_kind, actor_user_id, actor_role, action, module, record_type, record_id) values ('SESSION', private.current_profile_id(), private.erp_role(), 'UPDATED', 'Vehicles', 'Vehicle', '${vE.id}')`), /vehicle_driver_periods_no_overlap/, "overlapping periods refused by the database")
    await assert.rejects(sqlAs(OWNER, `update core.drivers set license_no = 'tn70   20110001234 ' where id = '${dMani.id}'; insert into audit.events (actor_kind, actor_user_id, actor_role, action, module, record_type, record_id) values ('SESSION', private.current_profile_id(), private.erp_role(), 'UPDATED', 'Drivers', 'Driver', '${dMani.id}')`), /drivers_license_no_key/, "a duplicate DL number (spaces / case ignored) refused by the database")
    // Document expiry alerts (22 Nov 2026): an active alert is calculated, never stored; updating the expiry date resolves
    // it — one append-only row, written with the vehicle's audited edit, read back in later requests (a restart) by the
    // Owner, Dev and Employee, never by the AdBlue profiles; nobody updates or deletes it through a session.
    {
      type DA = { vehicle_id: string; document: string; e: string; a: string; n: string | null }
      const alertRows = async () => (await db.query<DA>(`select vehicle_id, document, expiry_date::text e, alert_date::text a, new_expiry_date::text n from core.vehicle_document_alerts order by resolved_at, id`)).rows
      await call(EMP, "vehicles.update", vE.id, { insurance: { ...vE2.insurance, validTill: day(-3) } }) // 3 days left: active
      assert.deepEqual(await alertRows(), [], "an active alert is never stored")
      await call(EMP, "vehicles.update", vE.id, { insurance: { ...vE2.insurance, validTill: day(-3) }, notes: "seen" }) // viewing / unrelated edits
      assert.deepEqual(await alertRows(), [], "an edit that keeps the expiry date resolves nothing")
      await call(EMP, "vehicles.update", vE.id, { insurance: { ...vE2.insurance, validTill: day(-365) } })
      const resolvedRow = { vehicle_id: vE.id, document: "Insurance", e: day(-3), a: day(4), n: day(-365) }
      assert.deepEqual(await alertRows(), [resolvedRow], "the Employee's update resolves it: one row, the old date, when its alert began, the new date")
      for (const id of [OWNER, DEV, EMP]) {
        const h = (await call<Vehicle[]>(id, "vehicles.list")).find((x) => x.id === vE.id)!.documentAlertHistory!
        assert.deepEqual(h.map((r) => [r.document, r.expiryDate, r.alertDate, r.newExpiryDate, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(r.resolvedAt)]), [["Insurance", day(-3), day(4), day(-365), true]], `${id.role} reads the history back`)
      }
      const adb = (await call<Vehicle[]>(ADB, "vehicles.list")).find((x) => x.id === vE.id)
      assert.ok(adb && !("documentAlertHistory" in adb), "Adblue: the vehicle without its alert history")
      for (const id of [TATA, ADB]) assert.deepEqual(await rowsAs(id, `select 1 from core.vehicle_document_alerts`), [], `RLS: ${id.role} reads no alert history`)
      const ev = `insert into audit.events (actor_kind, actor_user_id, actor_role, action, module, record_type, record_id) values ('SESSION', private.current_profile_id(), private.erp_role(), 'UPDATED', 'Vehicles', 'Vehicle', '${vE.id}');`
      for (const id of [OWNER, DEV, EMP, TATA, ADB])
        for (const sql of [`update core.vehicle_document_alerts set expiry_date = '2020-01-01'; ${ev}`, `delete from core.vehicle_document_alerts; ${ev}`, `delete from core.vehicle_document_alerts`]) {
          await assert.rejects(sqlAs(id, sql), /permission denied/, `${id.role}: history never changed or removed (no grant): ${sql.slice(0, 50)}`)
          assert.deepEqual(await alertRows(), [resolvedRow])
        }
      const ver = `(select updated_at from core.vehicles where id = '${vE.id}')`
      const ins = `insert into core.vehicle_document_alerts (vehicle_id, document, reg_no, expiry_date, alert_date, vehicle_version) values ('${vE.id}', 'PUC', 'X', '${day(0)}', '${day(30)}', ${ver});`
      await assert.rejects(sqlAs(OWNER, ins), /no audit event|recorded only by the vehicle save/, "a row without the vehicle's save and audit event is refused")
      await assert.rejects(sqlAs(TATA, `${ins} ${ev}`), /row-level security|permission denied/, "the AdBlue profiles can't add one")
      await assert.rejects(sqlAs(OWNER, `${ins.replace(`'${day(30)}', ${ver});`, `'${day(-1)}', ${ver});`)} ${ev}`), /vehicle_document_alerts_dates/, "an alert can't begin after its expiry date")
      assert.deepEqual(await alertRows(), [resolvedRow])

      // Duplicate history (one row per expiry cycle), whatever the route:
      const insurance = (d: string) => `{"provider": "", "policyNo": "", "validTill": "${d}", "premium": 0}`
      const dupOf = (version: string) => `insert into core.vehicle_document_alerts (vehicle_id, document, reg_no, expiry_date, alert_date, new_expiry_date, vehicle_version) values ('${vE.id}', 'Insurance', 'X', '${day(-3)}', '${day(4)}', '${day(-365)}', ${version});`
      const evBA = (b: string, a: string) => `insert into audit.events (actor_kind, actor_user_id, actor_role, action, module, record_type, record_id, before, after) values ('SESSION', private.current_profile_id(), private.erp_role(), 'UPDATED', 'Vehicles', 'Vehicle', '${vE.id}', '{"insurance": ${insurance(b)}}'::jsonb, '{"insurance": ${insurance(a)}}'::jsonb);`
      //  * the same cycle again, with no new save (the version the first row already holds)
      await assert.rejects(sqlAs(OWNER, `${dupOf(ver)} ${evBA(day(-3), day(-365))}`), /vehicle_document_alerts_once|recorded only by the vehicle save|must record exactly/, "a repeated row for the same save is refused")
      //  * a later save that doesn't change the date (notes only — its event shows the date unchanged, as the app writes it)
      await assert.rejects(sqlAs(OWNER, `update core.vehicles set notes = 'retry' where id = '${vE.id}'; ${dupOf(ver)} ${evBA(day(-365), day(-365))}`), /recorded only by the vehicle save|must record exactly/, "a save that didn't change the date can't resolve its old cycle again")
      //  * …nor a save that changed it to something else
      await assert.rejects(sqlAs(OWNER, `update core.vehicles set insurance_valid_till = '${day(-366)}' where id = '${vE.id}'; ${dupOf(ver)} ${evBA(day(-365), day(-366))}`), /recorded only by the vehicle save|must record exactly/, "a row must match the change the save made")
      //  * a row whose vehicle wasn't saved in this transaction (its version is from an earlier save)
      await assert.rejects(sqlAs(OWNER, `${dupOf(`'${(await db.query<{ v: string }>(`select updated_at::text as v from core.vehicles where id = '${vE.id}'`)).rows[0].v}'`)} ${evBA(day(-3), day(-365))}`), /vehicle_document_alerts_once|recorded only by the vehicle save|must record exactly/, "no save, no row")
      //  * two rows for one save
      await assert.rejects(sqlAs(OWNER, `update core.vehicles set insurance_valid_till = '${day(-366)}' where id = '${vE.id}'; ${dupOf(ver).replace(`'${day(-365)}'`, `'${day(-366)}'`)} ${dupOf(ver).replace(`'${day(-365)}'`, `'${day(-366)}'`)} ${evBA(day(-3), day(-366))}`), /vehicle_document_alerts_once/, "one row per document per save")
      //  * a retried request (the version the screen read is stale): refused before anything is written
      const seen = (await call<Vehicle[]>(EMP, "vehicles.list")).find((x) => x.id === vE.id)!
      await call(EMP, "vehicles.update", vE.id, { insurance: { ...vE2.insurance, validTill: day(-3) } }) // back to the original date: a new cycle begins
      await assert.rejects(as(EMP, () => api.vehicles.update(vE.id, { insurance: { ...vE2.insurance, validTill: day(-3) } }), true, { [vE.id]: seen.updatedAt }), (e: unknown) => e instanceof ConflictError, "a retry with the old version is refused")
      assert.deepEqual(await alertRows(), [resolvedRow], "…nothing added (the 1-year date never alerted, so nothing to resolve)")
      //  * the genuine new cycle for the same expiry date is resolved again, and kept as its own row
      await call(EMP, "vehicles.update", vE.id, { insurance: { ...vE2.insurance, validTill: day(-2) } })
      assert.deepEqual(await alertRows(), [resolvedRow, { ...resolvedRow, n: day(-2) }], "changed back and resolved again: a second cycle, history kept")
      await call(EMP, "vehicles.update", vE.id, { insurance: { ...vE2.insurance, validTill: day(-2) } }) // saved again, same date
      assert.equal((await alertRows()).length, 2, "saving the same date again adds nothing")
      //  * every document at once (the guard's paths = the app's fields), from one save: one row each
      await call(EMP, "vehicles.update", vE.id, { roadTax: { ...vE2.roadTax, validTill: day(-4) }, fitnessValidTill: day(-20), pucValidTill: day(-25) })
      assert.deepEqual((await alertRows()).slice(2).map((r) => [r.document, r.e, r.n]), [["PUC", day(-30), day(-25)]], "the PUC already in its window (30 days ahead) is resolved by this save too")
      await call(EMP, "vehicles.update", vE.id, { insurance: { ...vE2.insurance, validTill: "" }, roadTax: { ...vE2.roadTax, validTill: day(-370) }, fitnessValidTill: day(-400), pucValidTill: day(-200) })
      const all4 = (await alertRows()).slice(3)
      assert.deepEqual(all4.map((r) => [r.document, r.e, r.n]).sort(), [["Fitness", day(-20), day(-400)], ["Insurance", day(-2), null], ["PUC", day(-25), day(-200)], ["Road tax", day(-4), day(-370)]], "Insurance (removed), Road tax, Fitness and PUC resolved by one save")
      assert.equal((await db.query<{ n: number }>(`select count(distinct vehicle_version)::int as n from core.vehicle_document_alerts`)).rows[0].n, 4, "four saves, four versions (the four documents of the last save share one)")
      await call(EMP, "vehicles.update", vE.id, { insurance: vE2.insurance, roadTax: vE2.roadTax, fitnessValidTill: vE2.fitnessValidTill, pucValidTill: vE2.pucValidTill }) // as before (dates outside their windows)
      assert.equal((await alertRows()).length, 7)
      // The stage-3 verifier (22-vehicle-document-alerts-activation-preflight.sql) agrees with the real app: every alert
      // the engine's saves resolved has its row in the same transaction, and no row is unexplained (row 2 says
      // "applied" here — every migration, stage 4 included, is loaded).
      {
        const activation = readFileSync(new URL("../../../../supabase/scripts/production-readonly/22-vehicle-document-alerts-activation-preflight.sql", import.meta.url), "utf8")
        const rows22 = (await db.query<Record<string, string>>(activation)).rows
        assert.deepEqual(rows22.filter((r) => r.status === "STOP").map((r) => r.check_no), [2], "22 on the app's own saves: only row 2 (stage 4 already loaded here)")
        assert.match(rows22.find((r) => r.check_no === (4 as never))!.actual, /^\d+ · 7 · 7$/, "22: the seven alerts the app resolved, seven rows")
      }

      // Raw SQL can't bypass the lifecycle (core.vehicles trigger vehicles_document_alerts, 22 Nov 2026): every save of a
      // vehicle must carry EXACTLY the history rows for the alerts it resolved — no fewer (a bypass), no more (a duplicate
      // or invented one). Each statement below runs as the Owner in one transaction, as the SQL editor would.
      {
        const DOC = { Insurance: ["insurance_valid_till", "insurance"], "Road tax": ["road_tax_valid_till", "roadTax"], Fitness: ["fitness_valid_till", "fitnessValidTill"], PUC: ["puc_valid_till", "pucValidTill"] } as const
        type Doc = keyof typeof DOC
        const snap = (dates: Partial<Record<Doc, string | null>>) =>
          JSON.stringify(Object.fromEntries(Object.entries(dates).map(([d, v]) => (DOC[d as Doc][1] === "insurance" || DOC[d as Doc][1] === "roadTax" ? [DOC[d as Doc][1], { validTill: v ?? "" }] : [DOC[d as Doc][1], v ?? ""]))))
        const sqlDay = (d: string | null) => (d === null ? "null" : `'${d}'`)
        // One save: UPDATE the dates (from → to), optional history rows, then its audit event recording before → after.
        // (pg_sleep: PGlite's clock ticks in milliseconds — Postgres's in microseconds — so two raw saves in a row could
        // otherwise share one updated_at here. Through the app every save takes several round trips anyway.)
        const save = (from: Partial<Record<Doc, string | null>>, to: Partial<Record<Doc, string | null>>, rows = "", extra = "") =>
          `select pg_sleep(0.002); update core.vehicles set ${Object.entries(to).map(([d, v]) => `${DOC[d as Doc][0]} = ${sqlDay(v)}`).join(", ") || "notes = notes || '.'"} where id = '${vE.id}'; ${rows} ${extra}
           insert into audit.events (actor_kind, actor_user_id, actor_role, action, module, record_type, record_id, before, after) values ('SESSION', private.current_profile_id(), private.erp_role(), 'UPDATED', 'Vehicles', 'Vehicle', '${vE.id}', '${snap(from)}'::jsonb, '${snap(to)}'::jsonb);`
        const row = (doc: Doc, expiry: string, alert: string, next: string | null, version = ver) =>
          `insert into core.vehicle_document_alerts (vehicle_id, document, reg_no, expiry_date, alert_date, new_expiry_date, vehicle_version) values ('${vE.id}', '${doc}', 'X', '${expiry}', '${alert}', ${sqlDay(next)}, ${version});`
        const dates = async () => (await db.query<Record<string, string | null>>(`select insurance_valid_till::text i, road_tax_valid_till::text r, fitness_valid_till::text f, puc_valid_till::text p, status::text s from core.vehicles where id = '${vE.id}'`)).rows[0]
        const count = async () => (await alertRows()).length
        const REFUSED = /must record exactly|recorded only by the vehicle save|vehicle_document_alerts_once/
        const refusedRaw = async (sql: string, msg: string) => {
          const [d0, n0] = [await dates(), await count()]
          await assert.rejects(sqlAs(OWNER, sql), REFUSED, msg)
          assert.deepEqual([await dates(), await count()], [d0, n0], `${msg}: nothing changed`)
        }
        // A known start, every date outside its warning period (nothing to resolve: no row needed, none allowed).
        const far = { Insurance: day(-100), "Road tax": day(-100), Fitness: day(-100), PUC: day(-100) }
        // (Through the app: the PUC is 30 days ahead — in its window — so this save resolves it and writes its row.)
        await call(EMP, "vehicles.update", vE.id, { insurance: { ...vE2.insurance, validTill: far.Insurance }, roadTax: { ...vE2.roadTax, validTill: far["Road tax"] }, fitnessValidTill: far.Fitness, pucValidTill: far.PUC })
        const n0 = await count()

        // 1. Regression (the guard's "saved in this transaction" test): a legitimate row whose vehicle version is EARLIER
        //    than the moment it is inserted — always so, the save stamps updated_at first — is accepted. Here 50 ms earlier.
        await sqlAs(OWNER, save({ Insurance: far.Insurance }, { Insurance: day(-5) })) // into its window: nothing resolved yet
        await sqlAs(OWNER, save({ Insurance: day(-5) }, { Insurance: day(-200) }, `select pg_sleep(0.05); ${row("Insurance", day(-5), day(2), day(-200))}`))
        const [gap] = (await db.query<{ ok: boolean }>(`select resolved_at > vehicle_version + interval '40 milliseconds' as ok from core.vehicle_document_alerts order by resolved_at desc limit 1`)).rows
        assert.deepEqual([gap.ok, await count()], [true, n0 + 1], "a valid row with a version earlier than now() / clock_timestamp() commits")

        // 2. The bypass: an alerting date changed by raw SQL (or by the previous app, which writes no row) without its row.
        await sqlAs(OWNER, save({ Insurance: day(-200), "Road tax": far["Road tax"] }, { Insurance: day(-3), "Road tax": day(-2) })) // both into their windows
        await refusedRaw(save({ Insurance: day(-3) }, { Insurance: day(-300) }), "an active alert's date changed without its history row is refused")
        await refusedRaw(save({ Insurance: day(-3) }, { Insurance: null }), "…so is removing the date (Not recorded)")

        // 3. Several documents in one save: one row each, all of them.
        await refusedRaw(save({ Insurance: day(-3), "Road tax": day(-2) }, { Insurance: day(-300), "Road tax": day(-301) }, row("Insurance", day(-3), day(4), day(-300))), "two alerts resolved, one row: refused")
        await sqlAs(OWNER, save({ Insurance: day(-3), "Road tax": day(-2) }, { Insurance: day(-300), "Road tax": day(-301) }, row("Insurance", day(-3), day(4), day(-300)) + row("Road tax", day(-2), day(3), day(-301))))
        assert.equal(await count(), n0 + 3, "two alerts resolved by one save: two rows, accepted")

        // 4. Notes-only save, even with a forged audit event claiming the old change: the save resolved nothing.
        await refusedRaw(`update core.vehicles set notes = 'notes only' where id = '${vE.id}'; ${row("Insurance", day(-3), day(4), day(-300))} ${evBA(day(-3), day(-300))}`, "a notes-only save can't re-record a resolved cycle (forged event)")

        // 5. Invalid rows for a real change: wrong alert date, wrong old date, a date that wasn't in its window, an Inactive date.
        await sqlAs(OWNER, save({ Insurance: day(-300) }, { Insurance: day(-1) }))
        await refusedRaw(save({ Insurance: day(-1) }, { Insurance: day(-400) }, row("Insurance", day(-1), day(1), day(-400))), "wrong alert date (Insurance begins 7 days before)")
        await refusedRaw(save({ Insurance: day(-2) }, { Insurance: day(-400) }, row("Insurance", day(-2), day(5), day(-400))), "an old date the vehicle never held (forged event and row agree)")
        await refusedRaw(save({ Fitness: far.Fitness }, { Fitness: day(-200) }, row("Fitness", far.Fitness, day(-70), day(-200))), "a date not yet in its warning period resolves nothing")
        await sqlAs(OWNER, save({ Fitness: far.Fitness }, { Fitness: day(-200) })) // …and needs no row

        // 6. Stale versions: a row stamped with an earlier save's version — with or without a new save in this transaction.
        const [{ v: oldVersion }] = (await db.query<{ v: string }>(`select updated_at::text v from core.vehicles where id = '${vE.id}'`)).rows
        await refusedRaw(`${row("Fitness", far.Fitness, day(-70), day(-200), `'${oldVersion}'`)} insert into audit.events (actor_kind, actor_user_id, actor_role, action, module, record_type, record_id, before, after) values ('SESSION', private.current_profile_id(), private.erp_role(), 'UPDATED', 'Vehicles', 'Vehicle', '${vE.id}', '{"fitnessValidTill": "${far.Fitness}"}'::jsonb, '{"fitnessValidTill": "${day(-200)}"}'::jsonb);`, "the vehicle's current version, but saved by an earlier transaction: refused")
        await refusedRaw(save({ Insurance: day(-1) }, { Insurance: day(-400) }, row("Insurance", day(-1), day(6), day(-400), `'${oldVersion}'`)), "a stale version with a new save: refused")

        //    Why the guard tests the row's xmin, not "updated_at < now()": a version is not proof of a save in this
        //    transaction. A vehicle INSERT may set updated_at itself (the touch trigger stamps updates only): one stamped
        //    in the future passed the old clock test forever after; it never passes the xmin test.
        await sqlAs(OWNER, `insert into core.vehicles (id, reg_no, company_code, type_code, fuel_type, insurance_valid_till, updated_at) values ('veh_future', 'TN70FUT0001', 'VT', 'BUS_41', 'DIESEL', '${day(-200)}', '2099-01-01T00:00:00Z');
          insert into audit.events (actor_kind, actor_user_id, actor_role, action, module, record_type, record_id) values ('SESSION', private.current_profile_id(), private.erp_role(), 'CREATED', 'Vehicles', 'Vehicle', 'veh_future');`)
        await assert.rejects(sqlAs(OWNER, `insert into core.vehicle_document_alerts (vehicle_id, document, reg_no, expiry_date, alert_date, new_expiry_date, vehicle_version) values ('veh_future', 'Insurance', 'X', '${day(-5)}', '${day(2)}', '${day(-200)}', '2099-01-01T00:00:00Z');
          insert into audit.events (actor_kind, actor_user_id, actor_role, action, module, record_type, record_id, before, after) values ('SESSION', private.current_profile_id(), private.erp_role(), 'UPDATED', 'Vehicles', 'Vehicle', 'veh_future', '{"insurance": {"validTill": "${day(-5)}"}}'::jsonb, '{"insurance": {"validTill": "${day(-200)}"}}'::jsonb);`), REFUSED, "a future-stamped version saved by an earlier transaction: refused (the old clock test let it through)")
        assert.equal((await db.query(`select 1 from core.vehicle_document_alerts where vehicle_id = 'veh_future'`)).rows.length, 0)

        // 7. Changing a date back. In one transaction: the first change's row can't be the latest save's — refused either way.
        await refusedRaw(save({ Insurance: day(-1) }, { Insurance: day(-500) }, row("Insurance", day(-1), day(6), day(-500)), `update core.vehicles set insurance_valid_till = '${day(-1)}' where id = '${vE.id}';`), "A → B → A in one transaction, with a row: refused")
        await refusedRaw(save({ Insurance: day(-1) }, { Insurance: day(-500) }, "", `update core.vehicles set insurance_valid_till = '${day(-1)}' where id = '${vE.id}';`), "A → B → A in one transaction, without: refused")
        //    Across saves: resolved, set back (outside its window: nothing), resolved again — a second cycle, its own row.
        await sqlAs(OWNER, save({ Insurance: day(-1) }, { Insurance: day(-500) }, row("Insurance", day(-1), day(6), day(-500))))
        await sqlAs(OWNER, save({ Insurance: day(-500) }, { Insurance: day(-1) }))
        await sqlAs(OWNER, save({ Insurance: day(-1) }, { Insurance: day(-600) }, row("Insurance", day(-1), day(6), day(-600))))
        assert.deepEqual((await alertRows()).slice(-2).map((r) => [r.document, r.e, r.n]), [["Insurance", day(-1), day(-500)], ["Insurance", day(-1), day(-600)]], "changed back and resolved again: two cycles kept")

        // 8. A vehicle created with a history row: a new vehicle resolved nothing.
        await assert.rejects(sqlAs(OWNER, `insert into core.vehicles (id, reg_no, company_code, type_code, fuel_type, insurance_valid_till) values ('veh_rawnew', 'TN70RAW0001', 'VT', 'BUS_41', 'DIESEL', '${day(-3)}');
          insert into core.vehicle_document_alerts (vehicle_id, document, reg_no, expiry_date, alert_date, new_expiry_date, vehicle_version) values ('veh_rawnew', 'Insurance', 'X', '${day(-9)}', '${day(-2)}', '${day(-3)}', (select updated_at from core.vehicles where id = 'veh_rawnew'));
          insert into audit.events (actor_kind, actor_user_id, actor_role, action, module, record_type, record_id, before, after) values ('SESSION', private.current_profile_id(), private.erp_role(), 'UPDATED', 'Vehicles', 'Vehicle', 'veh_rawnew', '{"insurance": {"validTill": "${day(-9)}"}}'::jsonb, '{"insurance": {"validTill": "${day(-3)}"}}'::jsonb);`), REFUSED, "a new vehicle with an invented history row is refused")
        assert.equal((await db.query(`select 1 from core.vehicles where id = 'veh_rawnew'`)).rows.length, 0)

        // 9. Archive / restore through the app (the Employee): an archive that changes an alerting date resolves it; an
        //    Archived vehicle raises no alerts, so its date changes — and the restore's — resolve nothing (resolvedByEdit).
        const ins = (d: string) => ({ insurance: { ...vE2.insurance, validTill: d } })
        await call(EMP, "vehicles.update", vE.id, ins(day(-2)))
        const nA = await count()
        await call(EMP, "vehicles.update", vE.id, { status: "ARCHIVED", ...ins(day(-700)) })
        assert.deepEqual([(await dates()).s, await count(), (await alertRows()).at(-1)!.n], ["ARCHIVED", nA + 1, day(-700)], "archived in the same save that changed an alerting date: resolved, kept")
        await call(EMP, "vehicles.update", vE.id, ins(day(-3)))
        await call(EMP, "vehicles.update", vE.id, ins(day(-800)))
        await call(EMP, "vehicles.update", vE.id, ins(day(-3)))
        await refusedRaw(save({ Insurance: day(-3) }, { Insurance: day(-900) }, row("Insurance", day(-3), day(4), day(-900))), "an Archived vehicle raises no alert: a row for it is refused")
        await call(EMP, "vehicles.update", vE.id, { status: "ACTIVE", ...ins(day(-900)) })
        assert.deepEqual([(await dates()).s, (await dates()).i, await count()], ["ACTIVE", day(-900), nA + 1], "Archived edits and the restore (with a date change) resolve nothing, and save")
        await call(EMP, "vehicles.update", vE.id, ins(day(-4)))
        await call(EMP, "vehicles.update", vE.id, { notes: "after restore" })
        await call(EMP, "vehicles.update", vE.id, ins(day(-950)))
        assert.equal(await count(), nA + 2, "restored: notes-only saves add nothing; the next alerting change is resolved again")
        await call(EMP, "vehicles.update", vE.id, { insurance: vE2.insurance, roadTax: vE2.roadTax, fitnessValidTill: vE2.fitnessValidTill, pucValidTill: vE2.pucValidTill })
      }
    }
    // With every migration applied, the Production post-apply verifier still shows every row OK: edit_delete_guard() and
    // its tables unchanged, the new table classified "owner/dev + audited edit", no table deletable outside an audited edit.
    {
      const post10 = readFileSync(new URL("../../../../supabase/scripts/production-readonly/10-adblue-vendors-post-apply.sql", import.meta.url), "utf8")
      const stops = (await db.query<Record<string, string>>(post10)).rows.filter((r) => r.status === "STOP").map((r) => `${r.check_no} ${r.check_name}: ${r.actual}`)
      assert.deepEqual(stops, [], "10-adblue-vendors-post-apply: every row OK after 20261121000000")
    }
    // The DL migration on data that already has a duplicate: it stops, names both drivers, and changes nothing.
    {
      const dlSql = readFileSync(new URL("20261121000100_driver_licence_unique.sql", dir), "utf8")
      const fix = (dl: string) => `update core.drivers set license_no = '${dl}' where id = '${dMani.id}'; insert into audit.events (actor_kind, action, module, record_type, record_id) values ('SYSTEM', 'UPDATED', 'Drivers', 'Fixture', '${dMani.id}');`
      await db.exec(`begin; drop index core.drivers_license_no_key; ${fix(" tn70 20110001234")} commit;`)
      await assert.rejects(db.exec(dlSql), /these drivers share a DL number — TN70 20110001234: (Mani|Ravi) .*, (Mani|Ravi) /, "duplicates reported by name and id")
      await db.exec("rollback").catch(() => undefined)
      assert.equal((await db.query(`select 1 from pg_indexes where indexname = 'drivers_license_no_key'`)).rows.length, 0, "…nothing created")
      assert.equal((await db.query<{ l: string }>(`select license_no as l from core.drivers where id = '${dMani.id}'`)).rows[0].l, " tn70 20110001234", "…no driver changed")
      await db.exec(`begin; ${fix("KA05 20190004321")} commit;`)
      await db.exec(dlSql)
      assert.equal((await db.query(`select 1 from pg_indexes where indexname = 'drivers_license_no_key'`)).rows.length, 1, "applies once the duplicate is corrected")
      await assert.rejects(db.exec(dlSql), /already applied/)
      await db.exec("rollback").catch(() => undefined)
    }

    // Direct DELETE statements, by each role, on every table whose rows an edit removes. Nothing may change for the
    // Employee and the AdBlue profiles — with no audit event, with an event that doesn't record the row, or on history.
    const childTables = ["core.vehicle_assignments", "core.vehicle_status_periods", "core.customer_status_periods", "core.customer_pricing", "core.customer_route_rates", "fuel.industrial_supply_allocations", "core.vehicle_driver_periods"]
    const childState = async () => JSON.stringify(await Promise.all(childTables.map(async (t) => (await db.query(`select to_jsonb(x) - 'updated_at' as r from ${t} x order by 1`)).rows)))
    const evAs = (action: string, module: string, type: string, rid: string, before: unknown) =>
      `insert into audit.events (actor_kind, actor_user_id, actor_role, action, module, record_type, record_id, before, after) values ('SESSION', private.current_profile_id(), private.erp_role(), '${action}', '${module}', '${type}', '${rid}', '${JSON.stringify(before)}'::jsonb, '{}'::jsonb);`
    const attempts = [
      ...childTables.map((t) => `delete from ${t}`), // a plain delete of everything
      `delete from core.vehicle_assignments where vehicle_id = '${vE.id}'; ${evAs("UPDATED", "Vehicles", "Vehicle", vE.id, {})}`,
      `delete from core.customer_pricing where customer_id = '${epsilon.id}'; ${evAs("UPDATED", "Customers", "Customer", epsilon.id, { pricing: epsilon.pricing })}`,
      `delete from core.customer_route_rates where customer_id = '${epsilon.id}'; ${evAs("UPDATED", "Customers", "Customer", epsilon.id, {})}`, // an event that doesn't record the row
      `delete from fuel.industrial_supply_allocations where supply_id = '${supplyId}'; ${evAs("UPDATED", "Diesel", "Industrial supply", supplyId, {})}`,
      // Driver history: closed or older periods can't be deleted, reopened or re-dated by them — even with an event recording them.
      `delete from core.vehicle_driver_periods where vehicle_id = '${vE.id}'; ${evAs("UPDATED", "Vehicles", "Vehicle", vE.id, { driverPeriods: vE2.driverPeriods })}`,
      `update core.vehicle_driver_periods set end_date = null where vehicle_id = '${vE.id}' and end_date is not null; ${evAs("UPDATED", "Vehicles", "Vehicle", vE.id, { driverPeriods: vE2.driverPeriods })}`,
      `update core.vehicle_driver_periods set start_date = '2020-01-01' where vehicle_id = '${vE.id}' and end_date is not null; ${evAs("UPDATED", "Vehicles", "Vehicle", vE.id, { driverPeriods: vE2.driverPeriods })}`,
      // History: an old status period, even with an event that records it — only today's latest period is a same-day undo.
      `delete from core.vehicle_status_periods where vehicle_id = '${vA.id}'; ${evAs("RESTORED", "Vehicles", "Vehicle", vA.id, { statusHistory: (await periods("vehicle_status_periods", "vehicle_id", vA.id)).map((p) => ({ status: p.status, startDate: p.start })) })}`,
      // A customer's only period (created today) is never a same-day undo.
      `delete from core.customer_status_periods where customer_id = '${epsilon.id}'; ${evAs("RESTORED", "Customers", "Customer", epsilon.id, { statusHistory: (await periods("customer_status_periods", "customer_id", epsilon.id)).map((p) => ({ status: p.status, startDate: p.start })) })}`,
    ]
    const state0 = await childState()
    for (const id of [EMP, TATA, ADB])
      for (const sql of attempts) {
        await sqlAs(id, sql).catch(() => undefined) // refused by RLS (0 rows), by a grant, or at COMMIT by edit_delete_guard
        assert.equal(await childState(), state0, `${id.role}: nothing deleted by: ${sql.slice(0, 90)}`)
      }
    await assert.rejects(sqlAs(EMP, `delete from core.customer_route_rates where customer_id = '${epsilon.id}'`), /Only the Owner and Dev can delete records|no audit event/, "the Employee is told why")
    await assert.rejects(sqlAs(EMP, `delete from fuel.industrial_supply_allocations where supply_id = '${supplyId}'; ${evAs("UPDATED", "Diesel", "Industrial supply", supplyId, {})}`), /Only the Owner and Dev can delete records/)
    // The Owner and Dev may delete each (shown in a rolled-back transaction: the policies let the rows through).
    for (const id of [OWNER, DEV])
      for (const t of childTables) assert.ok((await rowsAs(id, `delete from ${t} returning 1`)).length > 0, `${id.role} deletes ${t}`)
    assert.equal(await childState(), state0)
    /* -------------------------------------------------------------- 12f. Tyre Data on the shared database (owner, 17 Nov 2026) */
    {
      const { lineAmounts, tyreTotals } = await import("@/domain/tyre")
      type TI = import("@/lib/types").TyreInvoice
      type TM = import("@/lib/types").TyreMaster
      const masters = await call<TM[]>(EMP, "tyreMasters.list")
      assert.equal(masters.filter((m) => m.kind === "REPAIR_TYPE").length, 12, "the migration's 12 starting repair types")
      const rtId = (n: string) => masters.find((m) => m.kind === "REPAIR_TYPE" && m.name === n)!.id
      const supplier = await call<TM>(EMP, "tyreMasters.create", { kind: "SUPPLIER", name: "Bhagyalakshmi Tyres" })
      await assert.rejects(call(EMP, "tyreMasters.create", { kind: "SUPPLIER", name: " bhagyalakshmi  TYRES" }), /already exists/, "no duplicate supplier")
      await assert.rejects(sqlAs(EMP, `insert into ops.tyre_masters (kind, name) values ('SUPPLIER', 'BHAGYALAKSHMI   tyres'); insert into audit.events (actor_kind, actor_user_id, actor_role, action, module, record_type, record_id) values ('SESSION', private.current_profile_id(), private.erp_role(), 'CREATED', 'Tyre', 'Supplier', 'x')`), /tyre_masters_name_key/, "…and the database's unique name rule (spaces / case ignored)")
      const brand = await call<TM>(EMP, "tyreMasters.create", { kind: "BRAND", name: "Apollo" })
      const ln = (repairTypeId: string, quantity: number, rate: number, x: Record<string, unknown> = {}) => ({ repairTypeId, quantity, rate, gstRate: 18, taxType: "CGST_SGST", ...x })
      const body = (items: unknown[], x: Record<string, unknown> = {}) => ({ date: today, vehicleId: vA.id, supplierId: supplier.id, billNo: "B-1", items, ...x })
      const t1 = await call<TI>(EMP, "tyreInvoices.create", body([ln(rtId("New Tyre Purchased"), 2, 14650, { brandId: brand.id, openingKm: 100, closingKm: 900 }), ln(rtId("Wheel Alignment"), 4, 400), ln(rtId("Tyre Fitting"), 3, 33.33)]))
      assert.equal(t1.customerId, alpha.id, "company from the assignment, on the server")
      const dbLines = (await db.query<{ id: string; base: string; cgst: string; sgst: string; igst: string; total: string }>(`select id, base_value::text as base, cgst::text, sgst::text, igst::text, total_value::text as total from ops.tyre_invoice_items where invoice_id = '${t1.id}' order by line_no`)).rows
      assert.deepEqual(dbLines.map((r) => [Number(r.base), Number(r.cgst), Number(r.sgst), Number(r.igst), Number(r.total)]), t1.items.map((i) => { const a = lineAmounts(i.quantity, i.rate, i.gstRate, i.taxType); return [a.baseValue, a.cgst, a.sgst, a.igst, a.totalValue] }), "the database generates the same amounts as the app, to the paisa (incl. 99.99 → CGST 9.00 + SGST 9.00)")
      assert.equal(tyreTotals(t1.items).grandTotal, 36579.99) // ₹29,300 + ₹1,600 + ₹99.99, each + 18% (₹99.99 → ₹18.00 GST)
      // The Employee edits: a line removed (inside the audited edit), one changed, one added — the guard lets it through.
      const t2 = await call<TI>(EMP, "tyreInvoices.update", t1.id, body([{ ...t1.items[0], rate: 14500 }, ln(rtId("Wheel Balancing"), 1, 300)]), "Fitting free")
      assert.deepEqual([t2.items.length, t2.items[0].id, (await db.query(`select 1 from ops.tyre_invoice_items where invoice_id = '${t1.id}'`)).rows.length], [2, t1.items[0].id, 2], "lines replaced; the kept line keeps its id")
      await assert.rejects(call(EMP, "tyreInvoices.update", t1.id, body([{ ...t2.items[0], rate: 14000 }, t2.items[1]])), /Enter the reason for changing the repair lines/, "a financial edit needs a reason, on the server too")
      // Office / No Customer: only for a vehicle without a customer on the date, only when chosen; never a customer record.
      const { id: _vi, createdAt: _vc, updatedAt: _vu, statusHistory: _vs, ...vTpl } = vA
      void [_vi, _vc, _vu, _vs]
      const spare = await as(OWNER, () => api.vehicles.create({ ...vTpl, regNo: "TN70OF0001", assignedCustomerId: null, assignedSince: undefined, odometerKm: 0 } as never))
      await assert.rejects(call(EMP, "tyreInvoices.create", body([ln(rtId("Tyre Fitting"), 1, 200)], { vehicleId: spare.id })), /no customer assignment .* Office \/ No Customer/)
      await assert.rejects(call(EMP, "tyreInvoices.create", body([ln(rtId("Tyre Fitting"), 1, 200)], { office: true })), /can't be recorded as Office \/ No Customer/)
      const off = await call<TI>(EMP, "tyreInvoices.create", body([ln(rtId("Tyre Fitting"), 1, 200)], { vehicleId: spare.id, office: true, billNo: "B-1" }))
      assert.deepEqual((await db.query<{ office: boolean; customer_id: string | null }>(`select office, customer_id from ops.tyre_invoices where id = '${off.id}'`)).rows[0], { office: true, customer_id: null }, "stored as Office / No Customer, no customer")
      await assert.rejects(sqlAs(OWNER, `update ops.tyre_invoices set customer_id = '${alpha.id}' where id = '${off.id}'; ${`insert into audit.events (actor_kind, actor_user_id, actor_role, action, module, record_type, record_id) values ('SESSION', private.current_profile_id(), private.erp_role(), 'UPDATED', 'Tyre', 'Tyre invoice', '${off.id}');`}`), /tyre_invoices_check|check constraint/, "the database: office ⇔ no customer")
      await call(OWNER, "tyreInvoices.remove", off.id, "Test invoice")
      // Direct deletes: the Employee and the profiles change nothing; a line goes only inside an audited edit.
      const tyreState = async () => JSON.stringify((await db.query(`select (select count(*) from ops.tyre_invoices) as i, (select count(*) from ops.tyre_invoice_items) as l, (select count(*) from ops.tyre_masters) as m`)).rows)
      const s0 = await tyreState()
      const evT = (rid: string, before: unknown) => `insert into audit.events (actor_kind, actor_user_id, actor_role, action, module, record_type, record_id, before, after) values ('SESSION', private.current_profile_id(), private.erp_role(), 'UPDATED', 'Tyre', 'Tyre invoice', '${rid}', '${JSON.stringify(before)}'::jsonb, '{}'::jsonb);`
      for (const id of [EMP, TATA, ADB])
        for (const text of [`delete from ops.tyre_invoices`, `delete from ops.tyre_invoice_items`, `delete from ops.tyre_invoice_items where invoice_id = '${t1.id}'; ${evT(t1.id, {})}`, `delete from ops.tyre_masters`]) {
          await sqlAs(id, text).catch(() => undefined)
          assert.equal(await tyreState(), s0, `${id.role}: nothing deleted by ${text.slice(0, 60)}`)
        }
      await assert.rejects(sqlAs(EMP, `delete from ops.tyre_invoice_items where invoice_id = '${t1.id}'; ${evT(t1.id, {})}`), /Only the Owner and Dev can delete records/, "the Employee is told why")
      await assert.rejects(sqlAs(OWNER, `delete from ops.tyre_masters`), /permission denied/, "masters: no delete for anyone (archive)")
      // The profiles: no Tyre at all — the method list and RLS.
      for (const id of [TATA, ADB]) {
        await assert.rejects(call(id, "tyreInvoices.list"), /refused by the method list/)
        assert.deepEqual(await rowsAs(id, `select id from ops.tyre_invoices`), [], `RLS: ${id.role} reads no tyre invoice`)
      }
      // The database's own rules past the API: an invoice needs a line; the month lock; no change without its event.
      await assert.rejects(sqlAs(EMP, `insert into ops.tyre_invoices (id, date, vehicle_id, customer_id, supplier_id) values ('tyr_empty', '${today}', '${vA.id}', '${alpha.id}', '${supplier.id}'); insert into audit.events (actor_kind, actor_user_id, actor_role, action, module, record_type, record_id) values ('SESSION', private.current_profile_id(), private.erp_role(), 'CREATED', 'Tyre', 'Tyre invoice', 'tyr_empty');`), /at least one repair line/)
      await assert.rejects(sqlAs(EMP, `update ops.tyre_invoices set remarks = 'x' where id = '${t1.id}'`), /no audit event/)
      await assert.rejects(sqlAs(EMP, `insert into ops.tyre_invoices (id, date, vehicle_id, customer_id, supplier_id) values ('tyr_oct', '2026-10-15', '${vA.id}', '${alpha.id}', '${supplier.id}')`), /row-level security/, "RLS: the Employee writes nothing into a locked month")
      // The Owner deletes (the lines go with it) and restores.
      await call(OWNER, "tyreInvoices.remove", t1.id, "Duplicate bill")
      assert.deepEqual((await db.query(`select 1 from ops.tyre_invoice_items where invoice_id = '${t1.id}'`)).rows, [], "the lines went with the invoice")
      const delEv = (await read(DEV, () => api.audit.list())).find((e) => e.action === "DELETED" && e.recordId === t1.id)!
      await as(OWNER, () => api.audit.restoreDeleted(delEv.id, "Not a duplicate"))
      assert.equal((await db.query(`select 1 from ops.tyre_invoice_items where invoice_id = '${t1.id}'`)).rows.length, 2, "restored with its lines")

      // Vendor payments (owner, 17 Nov 2026): the invoice and its first payment in one transaction; allocations; permanent delete.
      type TP = import("@/lib/types").TyrePayment
      const paidOf = async (invoiceId: string) => Number((await db.query<{ s: string }>(`select coalesce(sum(a.amount), 0)::text as s from ops.tyre_payment_allocations a join ops.tyre_payments p on p.id = a.payment_id where a.invoice_id = '${invoiceId}'`)).rows[0].s)
      const counts = async () => JSON.stringify((await db.query(`select (select count(*) from ops.tyre_invoices) as i, (select count(*) from ops.tyre_payments) as p, (select count(*) from ops.tyre_payment_allocations) as a`)).rows)
      const c0 = await counts()
      await assert.rejects(call(EMP, "tyreInvoices.create", body([ln(rtId("Wheel Alignment"), 1, 1000)], { billNo: "P-0", paymentMode: "NEFT", payment: { amount: 500, utr: " ", date: today } })), /UTR/, "no UTR, no invoice (server)")
      assert.equal(await counts(), c0, "nothing saved")
      const pi = await call<TI>(EMP, "tyreInvoices.create", body([ln(rtId("Wheel Alignment"), 1, 1000)], { billNo: "P-1", paymentMode: "NEFT", payment: { amount: 500, utr: "NEFT 001", date: today } })) // ₹1,180
      const [first] = (await call<TP[]>(EMP, "tyrePayments.list")).filter((p) => p.allocations.some((a) => a.invoiceId === pi.id))
      assert.deepEqual([await paidOf(pi.id), first.amount, first.mode, first.utr], [500, 500, "NEFT", "NEFT 001"], "invoice + payment + allocation, stored together")
      const adv = await call<TP>(EMP, "tyrePayments.create", { date: today, supplierId: supplier.id, amount: 1000, mode: "UPI", utr: "UPI-ADV", allocations: [], acceptAdvance: true })
      const used = await call<TP>(EMP, "tyrePayments.allocate", adv.id, [{ invoiceId: pi.id, amount: 680 }])
      assert.deepEqual([await paidOf(pi.id), used.allocations, used.amount], [1180, [{ invoiceId: pi.id, amount: 680 }], 1000], "advance applied: paid in full, ₹320 advance left")
      await assert.rejects(call(EMP, "tyrePayments.remove", adv.id, "Wrong cheque"), /can't/, "the Employee deletes no payment")
      // The database's own rules, past the API.
      const evP = (rid: string, action = "UPDATED") => `insert into audit.events (actor_kind, actor_user_id, actor_role, action, module, record_type, record_id) values ('SESSION', private.current_profile_id(), private.erp_role(), '${action}', 'Tyre', 'Tyre payment', '${rid}');`
      const s1 = await counts()
      await assert.rejects(sqlAs(OWNER, `update ops.tyre_payments set amount = 1 where id = '${adv.id}'; ${evP(adv.id)}`), /more than the payment settles/, "an edit can't leave the allocations above what the payment settles")
      await assert.rejects(sqlAs(OWNER, `update ops.tyre_payments set supplier_id = 'tym_another' where id = '${adv.id}'; ${evP(adv.id)}`), /vendor never changes/, "a payment's vendor never changes")
      await assert.rejects(sqlAs(OWNER, `delete from ops.tyre_payments where id = '${adv.id}'`), /no audit event/, "no payment deleted without its DELETED event")
      await assert.rejects(sqlAs(OWNER, `delete from ops.tyre_payments where id = '${adv.id}'; ${evP(adv.id)}`), /no audit event/, "…an UPDATED event isn't one")
      await sqlAs(EMP, `delete from ops.tyre_payments where id = '${adv.id}'`).catch(() => undefined)
      await sqlAs(EMP, `delete from ops.tyre_payments where id = '${adv.id}'; ${evP(adv.id, "DELETED")}`).catch(() => undefined)
      assert.equal((await db.query(`select 1 from ops.tyre_payments where id = '${adv.id}'`)).rows.length, 1, "RLS: the Employee deletes no payment, even with an event")
      // Allocations are removed only inside an audited edit of their payment (17 Nov 2026 — corrections rewrite them).
      await assert.rejects(sqlAs(OWNER, `delete from ops.tyre_payment_allocations where payment_id = '${adv.id}'`), /no audit event/, "no allocation removed without its payment's event")
      await assert.rejects(sqlAs(EMP, `delete from ops.tyre_payment_allocations where payment_id = '${adv.id}'; ${evP(adv.id)}`), /Only the Owner and Dev can delete records: a tyre payment allocation/, "the Employee removes one only inside a real edit (its before snapshot)")
      await assert.rejects(sqlAs(EMP, `insert into ops.tyre_payment_allocations (payment_id, line_no, invoice_id, amount) values ('${adv.id}', 9, '${pi.id}', 1); ${evP(adv.id)}`), /beyond its total/, "never beyond the invoice total")
      await assert.rejects(sqlAs(EMP, `insert into ops.tyre_payment_allocations (payment_id, line_no, invoice_id, amount) values ('${adv.id}', 9, '${t1.id}', 321); ${evP(adv.id)}`), /more than the payment/, "never beyond the payment")
      const other = await call<TM>(EMP, "tyreMasters.create", { kind: "SUPPLIER", name: "Other Tyres" })
      const oi = await call<TI>(EMP, "tyreInvoices.create", body([ln(rtId("Wheel Alignment"), 1, 100)], { supplierId: other.id, billNo: "O-1" }))
      await assert.rejects(sqlAs(EMP, `insert into ops.tyre_payment_allocations (payment_id, line_no, invoice_id, amount) values ('${adv.id}', 9, '${oi.id}', 10); ${evP(adv.id)}`), /another supplier/, "only the payment's own supplier")
      await assert.rejects(sqlAs(EMP, `insert into ops.tyre_payments (date, supplier_id, amount, mode, utr) values ('${today}', '${supplier.id}', 10, 'Credit', 'C-1')`), /check constraint/, "Credit is never a payment")
      await assert.rejects(sqlAs(EMP, `insert into ops.tyre_payments (date, supplier_id, amount, mode, utr) values ('${today}', '${supplier.id}', 10, 'Cash', '  ')`), /check constraint/, "a UTR on every payment")
      await assert.rejects(sqlAs(EMP, `insert into ops.tyre_payments (id, date, supplier_id, amount, mode, utr) values ('tpy_dup', '${today}', '${supplier.id}', 10, 'Cash', 'upi-adv'); ${evP("tpy_dup", "PAYMENT_RECORDED")}`), /tyre_payments_utr_key/, "one UTR, one live payment (spaces / case ignored)")
      await assert.rejects(sqlAs(EMP, `insert into ops.tyre_payments (id, date, supplier_id, amount, mode, utr) values ('tpy_oct', '2026-10-15', '${supplier.id}', 10, 'Cash', 'OCT-1'); ${evP("tpy_oct", "PAYMENT_RECORDED")}`), /row-level security/, "the month lock")
      await assert.rejects(sqlAs(OWNER, `update ops.tyre_invoice_items set rate = 10 where invoice_id = '${pi.id}'; ${evT(pi.id, {})}`), /beyond its total/, "an invoice edit never goes below what was paid")
      await assert.rejects(sqlAs(OWNER, `delete from ops.tyre_invoices where id = '${pi.id}'; ${evT(pi.id, {}).replace("'UPDATED'", "'DELETED'")}`), /foreign key/, "an invoice with payments is never deleted")
      await assert.rejects(call(OWNER, "tyreInvoices.remove", pi.id, "Duplicate"), /delete those payments first/)
      assert.equal(await counts(), JSON.stringify(JSON.parse(s1).map((r: Record<string, number | string>) => ({ ...r, i: Number(r.i) + 1 }))), "nothing else changed (only the other supplier's invoice was added)")
      // The Owner deletes it through the engine: the payment row and its allocation go in one transaction with the DELETED event.
      await call(OWNER, "tyrePayments.remove", adv.id, "Cheque bounced")
      assert.deepEqual([(await db.query(`select 1 from ops.tyre_payments where id = '${adv.id}'`)).rows.length, (await db.query(`select 1 from ops.tyre_payment_allocations where payment_id = '${adv.id}'`)).rows.length, await paidOf(pi.id)], [0, 0, 500], "deleted: no payment, no orphan allocation; the invoice owes ₹680 again")
      const payDel = (await db.query<{ reason: string; role: string; alloc: string; utr: string; at: string | null }>(`select reason, actor_role::text as role, before->'allocations' as alloc, before->>'utr' as utr, at::text as at from audit.events where record_id = '${adv.id}' and action = 'DELETED'`)).rows
      assert.deepEqual(payDel.map((e) => [e.reason, e.role, e.alloc, e.utr, !!e.at]), [["Cheque bounced", "OWNER", [{ invoiceId: pi.id, amount: 680 }], "UPI-ADV", true]], "the audit event outlives the payment: its allocations, reference, reason, who and when")
      assert.ok(!(await call<TP[]>(OWNER, "tyrePayments.list")).some((p) => p.id === adv.id), "gone from every list")
      await call<TP>(EMP, "tyrePayments.create", { date: today, supplierId: supplier.id, amount: 680, mode: "UPI", utr: "UPI-ADV", allocations: [{ invoiceId: pi.id, amount: 680 }] })
      assert.equal(await paidOf(pi.id), 1180, "the deleted payment's reference is free again")
      // "Deduct TDS?" and corrections (owner, 17 Nov 2026): ₹1,00,000 settled at 0.1% = ₹99,900 paid + ₹100 TDS.
      const big = await call<TI>(EMP, "tyreInvoices.create", body([ln(rtId("New Tyre Purchased"), 10, 10000, { gstRate: 0 })], { billNo: "T-1" })) // ₹1,00,000, no GST
      const tp = await call<TP>(EMP, "tyrePayments.create", { date: today, supplierId: supplier.id, amount: 100000, tdsPercent: 0.1, mode: "IMPS", utr: "IMPS-1", allocations: [{ invoiceId: big.id, amount: 100000 }] })
      const tpRow = (await db.query<{ a: string; t: string; r: string }>(`select amount::text as a, tds_amount::text as t, tds_rate::text as r from ops.tyre_payments where id = '${tp.id}'`)).rows[0]
      assert.deepEqual([tpRow, await paidOf(big.id)], [{ a: "99900.00", t: "100.00", r: "0.1000" }, 100000], "stored ₹99,900 paid + ₹100 TDS; the invoice is paid in full (₹1,00,000 settled)")
      await assert.rejects(sqlAs(OWNER, `update ops.tyre_payments set tds_amount = 50 where id = '${tp.id}'; ${evP(tp.id)}`), /tyre_payments_tds_check/, "the database checks TDS = settled × % / 100")
      // The Employee corrects it: 1%, and part of it moved off the bill (allocations rewritten inside the audited edit).
      const tpNow = (await call<TP[]>(EMP, "tyrePayments.list")).find((x) => x.id === tp.id)!
      await as(EMP, () => api.tyrePayments.update(tp.id, { date: today, amount: 100000, tdsPercent: 1, mode: "IMPS", utr: "IMPS-1", allocations: [{ invoiceId: big.id, amount: 60000 }], acceptAdvance: true }, "1% applies; part is advance"), true, { [tp.id]: tpNow.updatedAt })
      const edited = (await db.query<{ a: string; t: string }>(`select amount::text as a, tds_amount::text as t from ops.tyre_payments where id = '${tp.id}'`)).rows[0]
      assert.deepEqual([edited, await paidOf(big.id), (await db.query(`select 1 from ops.tyre_payment_allocations where payment_id = '${tp.id}'`)).rows.length], [{ a: "99000.00", t: "1000.00" }, 60000, 1], "edited through the engine: ₹99,000 + ₹1,000; ₹60,000 on the bill, ₹40,000 advance")
      await assert.rejects(call(EMP, "tyrePayments.remove", tp.id, "Wrong"), /can't/, "deleting stays the Owner's and Dev's")
      await assert.rejects(sqlAs(EMP, `update ops.tyre_payments set date = '2026-10-15' where id = '${tp.id}'; ${evP(tp.id)}`), /row-level security|0 rows|no audit/i, "RLS: the Employee can't move a payment into a locked month")
      // A direct Owner delete with its event: the allocations go with the payment (on delete cascade).
      await sqlAs(OWNER, `delete from ops.tyre_payments where id = '${tp.id}'; ${evP(tp.id, "DELETED")}`)
      assert.deepEqual([(await db.query(`select 1 from ops.tyre_payment_allocations where payment_id = '${tp.id}'`)).rows.length, await paidOf(big.id)], [0, 0], "cascade: no allocation left; the bill owes its full ₹1,00,000 again")
      for (const id of [TATA, ADB]) {
        await assert.rejects(call(id, "tyrePayments.remove", tp.id, "x y z"), /refused by the method list/)
        await assert.rejects(call(id, "tyrePayments.list"), /refused by the method list/)
        assert.deepEqual(await rowsAs(id, `select id from ops.tyre_payments union all select id from ops.tyre_payment_allocations`), [], `RLS: ${id.role} reads no tyre payment`)
      }
    }

    /* -------------------------------------------------------------- 12g. AdBlue supplier payments (owner, 18 Nov 2026) */
    {
      type AP = import("@/lib/types").AdBluePayment
      const { purchaseValue } = await import("@/domain/adblue-payments")
      const vendor = await as(OWNER, () => api.adblueVendors.create({ name: "Payable Vendor", defaultRate: 50 }))
      const otherVendor = await as(OWNER, () => api.adblueVendors.create({ name: "Other Payable Vendor", defaultRate: 50 }))
      const paidOfP = async (id: string) => Number((await db.query<{ s: string }>(`select coalesce(sum(amount), 0)::text as s from fuel.adblue_payment_allocations where purchase_id = '${id}'`)).rows[0].s)
      const buyP = (x: Record<string, unknown>) => ({ date: today, adblueVendorId: vendor.id, product: "AdBlue", buckets: 10, litresPerBucket: 20, pricePerBucket: 1000, invoiceNo: "AB", notes: "", ...x })
      const credit = await call<AdBluePurchase>(EMP, "adbluePurchases.create", buyP({ invoiceNo: "AB-1", gstRate: 18 }))
      const cRow = (await db.query<{ c: string; g: string; l: string }>(`select total_cost::text as c, gst_amount::text as g, total_litres::text as l from fuel.adblue_purchases where id = '${credit.id}'`)).rows[0]
      assert.deepEqual([cRow, purchaseValue(credit), (await db.query(`select 1 from fuel.adblue_payments`)).rows.length], [{ c: "10000.00", g: "1800.00", l: "200.000" }, 11800, 0], "a credit purchase: ₹10,000 + ₹1,800 GST (generated by the database), 200 L, no payment")
      const part = await call<AdBluePurchase>(EMP, "adbluePurchases.create", buyP({ invoiceNo: "AB-2", payment: { type: "PARTIAL", amount: 4000, mode: "UPI", utr: "UPI-AB2" } }))
      assert.equal(await paidOfP(part.id), 4000, "purchase, payment and allocation stored together")
      const p = await call<AP>(EMP, "adbluePayments.create", { date: today, vendorId: vendor.id, amount: 20000, tdsPercent: 0.1, mode: "NEFT", utr: "NEFT-AB", allocations: [{ purchaseId: credit.id, amount: 11800 }, { purchaseId: part.id, amount: 6000 }], acceptAdvance: true })
      const pRow = (await db.query<{ a: string; t: string }>(`select amount::text as a, tds_amount::text as t from fuel.adblue_payments where id = '${p.id}'`)).rows[0]
      assert.deepEqual([pRow, await paidOfP(credit.id), await paidOfP(part.id)], [{ a: "19980.00", t: "20.00" }, 11800, 10000], "₹20,000 settled at 0.1%: ₹19,980 + ₹20 TDS; both purchases paid; ₹2,200 advance")
      // The database's own rules, past the API.
      const evA = (rid: string, action = "UPDATED", type = "AdBlue payment") => `insert into audit.events (actor_kind, actor_user_id, actor_role, action, module, record_type, record_id) values ('SESSION', private.current_profile_id(), private.erp_role(), '${action}', 'AdBlue', '${type}', '${rid}');`
      await assert.rejects(sqlAs(OWNER, `update fuel.adblue_payments set tds_amount = 5 where id = '${p.id}'; ${evA(p.id)}`), /adblue_payments_tds_check/, "TDS = settled × % / 100")
      await assert.rejects(sqlAs(OWNER, `update fuel.adblue_payments set vendor_id = '${otherVendor.id}' where id = '${p.id}'; ${evA(p.id)}`), /vendor never changes/)
      await assert.rejects(sqlAs(OWNER, `update fuel.adblue_payments set amount = 100, tds_rate = null, tds_amount = 0 where id = '${p.id}'; ${evA(p.id)}`), /more than the payment settles/, "allocations never above what the payment settles")
      await assert.rejects(sqlAs(OWNER, `insert into fuel.adblue_payment_allocations (payment_id, line_no, purchase_id, amount) values ('${p.id}', 9, '${credit.id}', 1); ${evA(p.id)}`), /beyond its value/, "a purchase is never paid beyond its value")
      await assert.rejects(sqlAs(OWNER, `update fuel.adblue_purchases set price_per_bucket = 100 where id = '${credit.id}'; ${evA(credit.id, "UPDATED", "AdBlue purchase")}`), /beyond its value/, "…not even after a purchase edit")
      await assert.rejects(sqlAs(OWNER, `delete from fuel.adblue_purchases where id = '${credit.id}'; ${evA(credit.id, "DELETED", "AdBlue purchase")}`), /foreign key/, "a purchase with payments isn't deleted")
      await assert.rejects(sqlAs(EMP, `insert into fuel.adblue_payments (date, vendor_id, amount, mode, utr) values ('${today}', '${vendor.id}', 10, 'Credit', 'C-1')`), /check constraint/, "Credit is never a payment")
      await assert.rejects(sqlAs(EMP, `insert into fuel.adblue_payments (id, date, vendor_id, amount, mode, utr) values ('abp_dup', '${today}', '${vendor.id}', 10, 'Cash', 'neft-ab'); ${evA("abp_dup", "PAYMENT_RECORDED")}`), /adblue_payments_utr_key/, "one reference, one payment")
      await assert.rejects(sqlAs(EMP, `insert into fuel.adblue_payments (id, date, vendor_id, amount, mode, utr) values ('abp_oct', '2026-10-15', '${vendor.id}', 10, 'Cash', 'OCT-AB'); ${evA("abp_oct", "PAYMENT_RECORDED")}`), /row-level security/, "the month lock")
      await assert.rejects(sqlAs(OWNER, `delete from fuel.adblue_payments where id = '${p.id}'`), /no audit event/, "no deletion without its DELETED event")
      await sqlAs(EMP, `delete from fuel.adblue_payments where id = '${p.id}'; ${evA(p.id, "DELETED")}`).catch(() => undefined)
      assert.equal((await db.query(`select 1 from fuel.adblue_payments where id = '${p.id}'`)).rows.length, 1, "RLS: the Employee deletes no payment, even with an event")
      await assert.rejects(sqlAs(EMP, `delete from fuel.adblue_payment_allocations where payment_id = '${p.id}'; ${evA(p.id)}`), /Only the Owner and Dev can delete records: an AdBlue payment allocation/, "the Employee removes an allocation only inside a real edit")
      // The Employee corrects it through the engine: one purchase only — the allocation rows rewritten inside the audited edit.
      const pNow = (await call<AP[]>(EMP, "adbluePayments.list")).find((x) => x.id === p.id)!
      await as(EMP, () => api.adbluePayments.update(p.id, { date: today, amount: 20000, tdsPercent: 0.1, mode: "NEFT", utr: "NEFT-AB", allocations: [{ purchaseId: credit.id, amount: 11800 }], acceptAdvance: true }, "Only AB-1 was paid"), true, { [p.id]: pNow.updatedAt })
      assert.deepEqual([await paidOfP(part.id), (await db.query(`select 1 from fuel.adblue_payment_allocations where payment_id = '${p.id}'`)).rows.length], [4000, 1], "edited: AB-2 owes ₹6,000 again")
      await assert.rejects(call(EMP, "adbluePayments.remove", p.id, "Wrong"), /Only the Owner and Dev/)
      // The Owner deletes it through the engine: payment, allocations and the DELETED event in one transaction.
      const litres = async () => (await db.query<{ l: string }>(`select sum(total_litres)::text as l from fuel.adblue_purchases`)).rows[0].l
      const l0 = await litres()
      await call(OWNER, "adbluePayments.remove", p.id, "Bank returned it")
      const gone = (await db.query<{ r: string; a: unknown; t: string }>(`select reason as r, before->'allocations' as a, before->>'tdsAmount' as t from audit.events where record_id = '${p.id}' and action = 'DELETED'`)).rows
      assert.deepEqual([(await db.query(`select 1 from fuel.adblue_payments where id = '${p.id}' union all select 1 from fuel.adblue_payment_allocations where payment_id = '${p.id}'`)).rows.length, await paidOfP(credit.id), gone], [0, 0, [{ r: "Bank returned it", a: [{ purchaseId: credit.id, amount: 11800 }], t: "20" }]], "deleted with its allocations; the audit event keeps them and the TDS")
      assert.equal(await litres(), l0, "stock never moves with a payment")
      // Edit Purchase → Credit to Fully Paid (Employee, through the engine): a payment and its allocation in one
      // transaction; the purchase row — the stock batch — is not written at all.
      const conv = await call<AdBluePurchase>(EMP, "adbluePurchases.create", buyP({ invoiceNo: "AB-CONV" }))
      const rowOf = async () => (await db.query<{ u: string; c: string }>(`select updated_at::text as u, total_cost::text as c from fuel.adblue_purchases where id = '${conv.id}'`)).rows[0]
      const convBefore = await rowOf()
      await call(EMP, "adbluePurchases.update", conv.id, buyP({ invoiceNo: "AB-CONV", payment: { type: "FULL", amount: 10000, mode: "RTGS", utr: "RTGS-CONV", date: today } }))
      assert.deepEqual([await rowOf(), await paidOfP(conv.id)], [convBefore, 10000], "Credit → Fully Paid: ₹10,000 paid; the purchase row untouched")
      await assert.rejects(call(EMP, "adbluePurchases.update", conv.id, buyP({ invoiceNo: "AB-CONV", payment: { type: "FULL", amount: 10000, mode: "RTGS", utr: "RTGS-CONV2", date: today } })), /already fully paid/, "saving again creates no duplicate")
      // Apply Advance (vendor page): the vendor's advance applied to a purchase — allocation rows on the existing payment, no new payment.
      const advP = await call<AP>(EMP, "adbluePayments.create", { date: today, vendorId: vendor.id, amount: 3000, mode: "IMPS", utr: "IMPS-ADV-AB", allocations: [], acceptAdvance: true })
      const owedP = await call<AdBluePurchase>(EMP, "adbluePurchases.create", buyP({ invoiceNo: "AB-ADV" }))
      const nPay = (await db.query(`select 1 from fuel.adblue_payments`)).rows.length
      await call(EMP, "adbluePayments.applyAdvance", vendor.id, [{ purchaseId: owedP.id, amount: 3000 }])
      assert.deepEqual([(await db.query(`select 1 from fuel.adblue_payments`)).rows.length, await paidOfP(owedP.id), (await db.query<{ p: string }>(`select payment_id as p from fuel.adblue_payment_allocations where purchase_id = '${owedP.id}'`)).rows.map((r) => r.p)], [nPay, 3000, [advP.id]], "advance applied through the engine: no new payment, the allocation on the advance's payment")
      await assert.rejects(call(TATA, "adbluePayments.applyAdvance", vendor.id, [{ purchaseId: owedP.id, amount: 1 }]), /refused by the method list/)
      // Direct purchases on credit (owner, 18 Nov 2026): the entry on CREDIT, its payment's allocation in entry_id.
      type AE = import("@/lib/types").AdBlueEntry
      const dBody = (x: Record<string, unknown> = {}) => ({ vehicleId: vA.id, customerId: alpha.id, date: today, closingKm: 9_000_000, quantityLitres: 50, invoiceNo: "DIR-1", notes: "", source: "DIRECT", adblueVendorId: vendor.id, vendorName: "", rate: 100, paymentMode: "CREDIT", ...x })
      const dEntry = await call<AE>(EMP, "adblue.create", dBody({ payment: { type: "PARTIAL", amount: 2000, mode: "UPI", utr: "UPI-DIR-1" } }))
      const dRows = async () => (await db.query<{ p: string | null; e: string | null; a: string }>(`select purchase_id as p, entry_id as e, amount::text as a from fuel.adblue_payment_allocations where entry_id = '${dEntry.id}' order by created_at`)).rows
      assert.deepEqual([(await db.query<{ m: string }>(`select payment_mode::text as m from fuel.adblue_entries where id = '${dEntry.id}'`)).rows[0].m, await dRows()], ["CREDIT", [{ p: null, e: dEntry.id, a: "2000.00" }]], "a direct purchase on credit, part paid: the allocation in entry_id")
      const mixPay = await call<AP>(EMP, "adbluePayments.create", { date: today, vendorId: vendor.id, amount: 4000, mode: "NEFT", utr: "NEFT-MIX-DB", allocations: [{ purchaseId: owedP.id, amount: 1000 }, { purchaseId: dEntry.id, amount: 3000 }] })
      const mixRows = (await db.query<{ p: string | null; e: string | null }>(`select purchase_id as p, entry_id as e from fuel.adblue_payment_allocations where payment_id = '${mixPay.id}' order by line_no`)).rows
      assert.deepEqual(mixRows, [{ p: owedP.id, e: null }, { p: null, e: dEntry.id }], "one payment across a bulk and a direct purchase")
      const evE = (rid: string, action = "UPDATED") => evA(rid, action, "AdBlue entry")
      await assert.rejects(sqlAs(OWNER, `insert into fuel.adblue_payment_allocations (payment_id, line_no, entry_id, amount) values ('${advP.id}', 9, '${dEntry.id}', 1); ${evA(advP.id)}`), /beyond its value|more than the payment settles/, "a direct purchase is never paid beyond its value")
      await assert.rejects(sqlAs(OWNER, `insert into fuel.adblue_payment_allocations (payment_id, line_no, purchase_id, entry_id, amount) values ('${mixPay.id}', 9, '${owedP.id}', '${dEntry.id}', 1); ${evA(mixPay.id)}`), /adblue_payment_allocations_target_check/, "an allocation points at exactly one purchase")
      await assert.rejects(sqlAs(OWNER, `update fuel.adblue_entries set payment_mode = 'CASH' where id = '${dEntry.id}'; ${evE(dEntry.id)}`), /not a direct purchase on credit/, "a paid direct purchase stays on credit")
      await assert.rejects(sqlAs(OWNER, `update fuel.adblue_entries set quantity_litres = 10 where id = '${dEntry.id}'; ${evE(dEntry.id)}`), /beyond its value/, "…and its amount never goes below what was paid")
      await assert.rejects(sqlAs(OWNER, `delete from fuel.adblue_entries where id = '${dEntry.id}'; ${evE(dEntry.id, "DELETED")}`), /foreign key/, "a direct purchase with payments isn't deleted")
      // The Employee corrects the mixed payment: the direct allocation removed inside the audited edit (the guard finds it by entry id).
      const mixNow = (await call<AP[]>(EMP, "adbluePayments.list")).find((x) => x.id === mixPay.id)!
      await as(EMP, () => api.adbluePayments.update(mixPay.id, { date: today, amount: 4000, mode: "NEFT", utr: "NEFT-MIX-DB", allocations: [{ purchaseId: owedP.id, amount: 1000 }], acceptAdvance: true }, "Direct part was a mistake"), true, { [mixPay.id]: mixNow.updatedAt })
      assert.deepEqual((await dRows()).map((r) => r.a), ["2000.00"], "the edit removed the direct allocation (₹3,000 back to advance)")
      await call(OWNER, "adbluePayments.remove", mixPay.id, "Re-enter")
      assert.equal((await db.query(`select 1 from fuel.adblue_payment_allocations where payment_id = '${mixPay.id}'`)).rows.length, 0, "deleted with its allocations")
      for (const id of [TATA, ADB]) {
        await assert.rejects(call(id, "adbluePayments.list"), /refused by the method list/)
        assert.deepEqual(await rowsAs(id, `select id from fuel.adblue_payments union all select id from fuel.adblue_payment_allocations`), [], `RLS: ${id.role} reads no AdBlue payment`)
        await assert.rejects(sqlAs(id, `insert into fuel.adblue_payments (id, date, vendor_id, amount, mode, utr) values ('abp_${id.role}', '${today}', '${vendor.id}', 10, 'Cash', 'R-${id.role}'); ${evA(`abp_${id.role}`, "PAYMENT_RECORDED")}`), /row-level security/, `RLS: ${id.role} records no payment`)
      }
    }

    /* -------------------------------------------------------------- 12h. tanker transfers / adjustments: edit = diesel:edit, delete = Owner / Dev (owner, 18 Nov 2026) */
    {
      const TX = await tk("Edit X", "KA01EDT0001", 400)
      const TY = await tk("Edit Y", "KA01EDT0002", 100)
      const tr = await call<TankerTransfer>(EMP, "tankerTransfers.create", { date: today, fromTankerId: TX, toTankerId: TY, litres: 100, notes: "" })
      const adj = await call<TankerAdjustment>(EMP, "tankerAdjustments.create", { date: today, tankerId: TY, litres: -20, reason: "Dip reading" })
      assert.deepEqual([await dbStock(TX), await dbStock(TY)], [300, 180])
      // The Employee corrects both, through the engine (RLS UPDATE policy + every trigger at COMMIT).
      const edT = await call<TankerTransfer>(EMP, "tankerTransfers.update", tr.id, { date: today, fromTankerId: TX, toTankerId: TY, litres: 150, notes: "Corrected" }, "Wrong litres")
      const edA = await call<TankerAdjustment>(EMP, "tankerAdjustments.update", adj.id, { date: today, tankerId: TY, litres: 15, reason: "Dip reading: 15 L more" }, "Direction was wrong")
      assert.deepEqual([edT.id, edT.litres, edA.id, edA.litres], [tr.id, 150, adj.id, 15], "edited in place — same records, no new rows")
      assert.deepEqual([await dbStock(TX), await dbStock(TY)], [250, 265], "stock recalculated once: X 400 − 150, Y 100 + 150 + 15")
      const ev = async (rid: string) => (await db.query<{ action: string; actor_role: string; reason: string | null; b: string | null }>(`select action, actor_role::text, reason, before ->> 'litres' as b from audit.events where record_id = '${rid}' order by at, id`)).rows
      assert.deepEqual((await ev(tr.id)).map((e) => [e.action, e.actor_role, e.reason, e.b]), [["CREATED", "EMPLOYEE", null, null], ["UPDATED", "EMPLOYEE", "Wrong litres", "100"]], "the edit is audited as the Employee, with the original litres")
      assert.deepEqual((await ev(adj.id)).at(-1), { action: "UPDATED", actor_role: "EMPLOYEE", reason: "Direction was wrong", b: "-20" })
      // Stock rules still hold on an edit — the API and the database's own trigger.
      await assert.rejects(call(EMP, "tankerTransfers.update", tr.id, { date: today, fromTankerId: TX, toTankerId: TY, litres: 401, notes: "" }), /Insufficient tanker inventory in Edit X/)
      await assert.rejects(sqlAs(EMP, `update fuel.tanker_transfers set litres = 401 where id = '${tr.id}'; ${evAs("UPDATED", "Diesel Tanker", "Tanker transfer", tr.id, {})}`), /Insufficient tanker inventory in Edit X/)
      await assert.rejects(call(EMP, "tankerAdjustments.update", adj.id, { date: today, tankerId: TY, litres: -251, reason: "Dip reading" }), /Insufficient tanker inventory in Edit Y/)
      await assert.rejects(sqlAs(EMP, `update fuel.tanker_adjustments set litres = 5 where id = '${adj.id}'`), /audit/i, "a direct UPDATE without its audit event is refused at COMMIT")
      // Deleting: refused to the Employee and the AdBlue profiles everywhere; the AdBlue profiles edit nothing either.
      const state = async () => JSON.stringify((await db.query(`select litres::text from fuel.tanker_transfers where id = '${tr.id}' union all select litres::text from fuel.tanker_adjustments where id = '${adj.id}'`)).rows)
      const s0 = await state()
      await assert.rejects(call(EMP, "tankerTransfers.remove", tr.id, "Entered twice"), /can't delete/)
      await assert.rejects(call(EMP, "tankerAdjustments.remove", adj.id, "Entered twice"), /can't delete/)
      for (const id of [EMP, TATA, ADB]) {
        await sqlAs(id, `delete from fuel.tanker_transfers where id = '${tr.id}'; delete from fuel.tanker_adjustments where id = '${adj.id}'; ${evAs("DELETED", "Diesel Tanker", "Tanker transfer", tr.id, {})}`).catch(() => undefined)
        assert.equal(await state(), s0, `${id.role}: a direct DELETE changes nothing`)
      }
      for (const id of [TATA, ADB]) {
        await assert.rejects(call(id, "tankerTransfers.update", tr.id, { date: today, fromTankerId: TX, toTankerId: TY, litres: 10, notes: "" }), /refused by the method list/)
        await sqlAs(id, `update fuel.tanker_transfers set litres = 10 where id = '${tr.id}'; update fuel.tanker_adjustments set litres = 1 where id = '${adj.id}'; ${evAs("UPDATED", "Diesel Tanker", "Tanker transfer", tr.id, {})}`).catch(() => undefined)
        assert.equal(await state(), s0, `${id.role}: diesel:view only — a direct UPDATE changes nothing`)
      }
      // The Owner and Dev delete (reason kept on the DELETED event with the last snapshot); stock goes back.
      await call(OWNER, "tankerTransfers.remove", tr.id, "Entered twice")
      await call(DEV, "tankerAdjustments.remove", adj.id, "Entered twice")
      assert.deepEqual((await ev(tr.id)).at(-1), { action: "DELETED", actor_role: "OWNER", reason: "Entered twice", b: "150" })
      assert.deepEqual((await ev(adj.id)).at(-1), { action: "DELETED", actor_role: "DEV", reason: "Entered twice", b: "15" })
      assert.deepEqual([await dbStock(TX), await dbStock(TY)], [400, 100])
    }

    // An Owner's direct delete commits with its audit event (the guard doesn't apply); the Employee's same statement doesn't.
    await sqlAs(OWNER, `delete from core.customer_route_rates where customer_id = '${epsilon.id}'; ${evAs("UPDATED", "Customers", "Customer", epsilon.id, {})}`)
    assert.deepEqual(await routeRows(), [], "the Owner deleted the route rate")
  }

  /* ---------------------------------------------------------------- 13. the shared database is never reset from the app */
  for (const id of [DEV, OWNER, EMP]) {
    await assert.rejects(as(id, () => api.admin.clearAllData()), /isn't available on the shared database/)
    await assert.rejects(as(id, () => api.admin.resetDemoData()), /isn't available on the shared database/)
  }
  await assert.rejects(read(OWNER, () => api.admin.exportBackup()), /Only Dev/)
  await assert.rejects(read(EMP, () => api.admin.exportBackup()), /Only Dev/)
  const backup = await read(DEV, () => api.admin.exportBackup())
  assert.ok((backup.collections.diesel_entries ?? []).length >= 5 && backup.format === "vishal-erp-backup", "Dev's read-only export (the rollback path)")
  void tf
  void load
  void pay

  /* ---------------------------------------------------------------- 14. the go-live scripts: backup, then reset (supabase/scripts) */
  await db.exec(`insert into auth.identities (user_id, provider, identity_data) values ('${U.DEV}', 'google', '{"email_verified": "true"}'), ('${U.OWNER}', 'google', '{}'), ('${U.EMP}', 'google', '{}')`)
  const scripts = new URL("../../../../supabase/scripts/", import.meta.url)
  const backupSql = readFileSync(new URL("02-backup-business-data.sql", scripts), "utf8")
  const backupRes = await db.exec(backupSql)
  const doc = (backupRes.at(-1)!.rows[0] as { backup: { row_counts: Record<string, number>; tables: Record<string, unknown[] | null> } }).backup
  for (const [t, n] of Object.entries(doc.row_counts)) assert.equal((doc.tables[t] ?? []).length, n, `backup complete: ${t}`)
  assert.ok(doc.row_counts["fuel.diesel_entries"] >= 5 && doc.row_counts["billing.invoices"] === 2 && doc.row_counts["core.customers"] === 6) // Minda, TEPL, Alpha, Beta, Gamma (12d), Epsilon (12e)
  const count = async (t: string) => Number(((await db.query<{ n: number }>(`select count(*)::int as n from ${t}`)).rows[0]).n)
  const before = { profiles: await count("public.profiles"), identities: await count("auth.identities"), users: await count("auth.users"), events: await count("audit.events"), reviews: await count("audit.reviews") }
  const resetSql = readFileSync(new URL("03-reset-business-data.sql", scripts), "utf8")
  const resetTx = resetSql.slice(resetSql.indexOf("\nbegin;") + 1, resetSql.indexOf("\ncommit;") + 8)
  await assert.rejects(db.exec(resetTx), /Not confirmed/, "the reset refuses to run without the typed confirmation")
  await db.exec("rollback").catch(() => undefined)
  assert.equal(await count("fuel.diesel_entries"), doc.row_counts["fuel.diesel_entries"], "…and changed nothing")
  await db.exec(`select set_config('vt.confirm_reset', 'dqnoducqiootfvkzskhu', false); ${resetTx}`)
  for (const t of ["core.customers", "core.vehicles", "core.drivers", "core.vehicle_assignments", "fuel.tankers", "fuel.diesel_entries", "fuel.tanker_loads", "fuel.adblue_purchases", "fuel.adblue_entries", "finance.payments", "finance.payment_allocations", "ops.trips", "billing.invoices", "billing.invoice_lines"])
    assert.equal(await count(t), 0, `reset cleared ${t}`)
  assert.deepEqual((await db.query<{ id: string }>(`select id from fuel.fuel_stations`)).rows.map((x) => x.id), ["dv_tanker"], "the internal tanker source is kept")
  assert.deepEqual([await count("public.profiles"), await count("auth.identities"), await count("auth.users"), await count("audit.reviews")], [before.profiles, before.identities, before.users, before.reviews], "accounts, Google identities, users and reviews untouched")
  assert.ok((await count("core.vehicle_types")) >= 9 && (await count("core.companies")) === 2 && (await count("core.app_settings")) === 1, "reference configuration kept")
  const resetEvents = await count("audit.events")
  assert.ok(resetEvents > before.events + 20, "every removed row has its DELETED event (the audit trail only grows)")
  const snap = (await db.query<{ before: { reg_no: string } }>(`select before from audit.events where action = 'DELETED' and record_type = 'core.vehicles' and record_id = '${bus.id}'`)).rows[0]
  assert.equal(snap.before.reg_no, "TN70AK1869", "…with the row's full snapshot")
  // The accounts still work after the reset, and nothing deleted by it can be "restored".
  assert.equal(await as(DEV, () => api.admin.setupTankerMasters()), 6)
  assert.equal((await read(OWNER, () => api.vehicles.list())).length, 3)
  const resetDel = (await read(DEV, () => api.audit.list())).find((e) => e.action === "DELETED" && e.recordId === bus.id && e.actor.kind === "SYSTEM")!
  assert.ok(!(await read(DEV, () => api.audit.checkRestore(resetDel.id))).ok, "records cleared by the go-live reset can't be pushed back")

  /* ---------------------------------------------------------------- 15. clean reset preserving every account (scripts 04 inventory, 05 parts A and B) */
  // Business data again (after the go-live reset): a station, a customer, payments, a reviewed deletion, a month lock.
  const st2 = await as(OWNER, () => api.fuelStations.create({ name: "Shrudu Fuels", location: "" }))
  await as(OWNER, () => api.customers.create({ ...minda, code: "JBM", shortName: "JBM", name: "JBM Bidadi" } as never))
  const payKeep = { stationId: st2.id, paymentDate: today, paymentMode: "UPI" as const, notes: "", companyCode: "VT" as const, forMonth: today.slice(0, 7) }
  await as(OWNER, () => api.fuelStationPayments.create({ ...payKeep, amount: 500 }))
  const pay2 = await as(OWNER, () => api.fuelStationPayments.create({ ...payKeep, amount: 7 }))
  const pay2Now = (await read(OWNER, () => api.payments.list())).find((x) => x.id === pay2.id)!
  await as(OWNER, () => api.fuelStationPayments.remove(pay2.id, "Entered twice"), true, { [pay2.id]: pay2Now.updatedAt })
  const pay2Del = (await read(DEV, () => api.audit.list())).find((e) => e.action === "DELETED" && e.recordId === pay2.id)!
  await as(OWNER, () => api.audit.markReviewed([pay2Del.id]))
  await as(DEV, () => api.monthLocks.set("2026-09", "LOCKED"))
  await db.exec(`alter table auth.users add column if not exists updated_at timestamptz default now(), add column if not exists last_sign_in_at timestamptz`) // as in Supabase
  type Inv = { tables: Record<string, number>; unknown_tables: string[]; account_fks: { from: string; to: string; on_delete: string }[]; profile_fks: { to: string }[]; accounts: Record<string, unknown>; audit_guards: Record<string, string>; audit_by_module: Record<string, number> | null }
  const inventory = async () => ((await db.exec(readFileSync(new URL("04-inventory.sql", scripts), "utf8"))).at(-1)!.rows[0] as { inventory: Inv }).inventory
  const inv0 = await inventory()
  assert.deepEqual(inv0.unknown_tables, [], "the reset script knows every table")
  assert.ok(inv0.profile_fks.every((f) => ["public.profiles", "auth.users"].includes(f.to)), "no foreign key from accounts into business data (nothing can cascade into a profile)")
  assert.ok(inv0.account_fks.length >= 4)
  assert.ok(inv0.tables["core.customers"] >= 1 && inv0.tables["finance.payments"] >= 1 && inv0.tables["audit.reviews"] >= 1 && inv0.tables["core.month_locks"] >= 1 && inv0.tables["fuel.tankers"] === 3)
  const reset05 = readFileSync(new URL("05-clean-reset-preserve-profiles.sql", scripts), "utf8")
  const partA = reset05.slice(reset05.indexOf("\nbegin;") + 1, reset05.indexOf("\ncommit;") + 8)
  const partB = reset05.slice(reset05.lastIndexOf("\nbegin;") + 1, reset05.lastIndexOf("\ncommit;") + 8)
  const REF = (sql: string) => sql.replace("TYPE-PROJECT-REF", "dqnoducqiootfvkzskhu")
  const refused = async (sql: string, why: RegExp) => {
    await assert.rejects(db.exec(sql), why)
    await db.exec("rollback").catch(() => undefined)
    assert.deepEqual((await inventory()).tables, inv0.tables, "a refused run changes nothing")
  }
  await refused(partA, /Not confirmed/)
  await db.exec("create table core.zz_reservations (id int)")
  await assert.rejects(db.exec(REF(partA)), /does not know: core\.zz_reservations/, "an uninspected table stops the reset")
  await db.exec("rollback").catch(() => undefined)
  await db.exec("drop table core.zz_reservations")
  await refused(REF(partB).replace("TYPE-MODE", "BUSINESS"), /run Part A first/)
  await refused(REF(partB), /Choose the mode/)
  // Part A: every business table empty; accounts, Google identities and configuration identical.
  await db.exec(REF(partA))
  const inv1 = await inventory()
  for (const [t, n] of Object.entries(inv1.tables))
    if (!["public.profiles", "core.role_permissions", "core.companies", "core.vehicle_types", "core.app_settings", "finance.payment_categories", "audit.events", "audit.reviews"].includes(t))
      assert.equal(n, t === "fuel.fuel_stations" ? 1 : 0, `part A cleared ${t}`)
  assert.deepEqual(inv1.accounts, inv0.accounts, "every profile, auth user and identity exactly as before")
  for (const t of ["core.role_permissions", "core.companies", "core.vehicle_types", "core.app_settings", "finance.payment_categories", "audit.reviews"]) assert.equal(inv1.tables[t], inv0.tables[t], `${t} kept`)
  assert.ok(inv1.tables["audit.events"] > inv0.tables["audit.events"], "part A only adds to the audit trail")
  // Part B, BUSINESS: only the Accounts history and one marker remain; the append-only guard is back on.
  const accountEvents = inv0.audit_by_module?.Accounts ?? 0
  await db.exec(REF(partB).replace("TYPE-MODE", "BUSINESS"))
  const inv2 = await inventory()
  assert.deepEqual(inv2.audit_by_module, { ...(accountEvents ? { Accounts: accountEvents } : {}), System: 1 }, "business audit history cleared, account history kept")
  assert.equal(inv2.tables["audit.reviews"], 0)
  assert.ok(Object.values(inv2.audit_guards).every((s) => s === "O"), "every audit trigger enabled again")
  assert.deepEqual(inv2.accounts, inv0.accounts)
  await assert.rejects(db.exec("delete from audit.events"), /append-only/, "the trail is append-only again")
  await assert.rejects(db.exec(`update public.profiles set full_name = 'Changed' where id = '${P.EMP}'`), /audit|account/i, "an account change still needs its audit event")
  await db.exec("rollback").catch(() => undefined)
  // Part B, ALL: nothing but the marker.
  await db.exec(REF(partB).replace("TYPE-MODE", "ALL"))
  const inv3 = await inventory()
  assert.deepEqual([inv3.tables["audit.events"], inv3.tables["audit.reviews"], inv3.audit_by_module], [1, 0, { System: 1 }])
  assert.deepEqual(inv3.accounts, inv0.accounts)
  // The application still authenticates its accounts and works on the clean database.
  assert.equal((await read(EMP, () => api.fuelStations.list())).length, 1, "only dv_tanker")
  const fresh2 = await as(OWNER, () => api.fuelStations.create({ name: "Vishal Gasoline" }))
  assert.ok((await read(EMP, () => api.fuelStations.list())).some((x) => x.id === fresh2.id), "a new record after the reset is saved and visible to another account")
  assert.equal((await read(DEV, () => api.audit.list())).filter((e) => e.recordId === fresh2.id).length, 1, "…with its audit event")
  await assert.rejects(as(EMP, () => api.settings.update({ tdsRate: 3 })), /can't edit settings/, "role permissions still apply")

  console.log("shared database (engine + RLS + every migration; Dev, Owner, Employee, Tata Adblue, Adblue): all checks passed")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
