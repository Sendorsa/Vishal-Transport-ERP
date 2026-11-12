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
import type { AdBlueEntry, AdBluePurchase, AuditEvent, Customer, DieselEntry } from "@/lib/types"
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
  await as(EMP, () => api.fuelStationPayments.remove(empPay.id, "Entered on the wrong pump"))
  assert.ok(!(await read(OWNER, () => api.fuelStationPayments.list())).some((p) => p.id === empPay.id), "the Employee edits and deletes payments, like the Owner")
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

  /* ---------------------------------------------------------------- 6. AdBlue: opening + bulk, weighted-average draw */
  await as(OWNER, () => api.adbluePurchases.create({ date: today, vendorName: "Bulk Vendor", product: "AdBlue", buckets: 10, litresPerBucket: 20, pricePerBucket: 900, invoiceNo: "", notes: "" }))
  const draw = await as(EMP, () => api.adblue.create({ date: today, vehicleId: bus.id, customerId: minda.id, closingKm: 120600, quantityLitres: 15, invoiceNo: "", notes: "", source: "STOCK" }))
  const ap = await read(OWNER, () => api.adbluePurchases.list())
  const inv = valueInventory(ap, stockDraws(await read(OWNER, () => api.adblue.list())))
  assert.deepEqual([inv.stockLitres, inv.stockValue, inv.costOf.get(draw.id)], [285, 17100, 900])
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
  await assert.rejects(as(EMP, () => api.diesel.remove(octFill.id, "Employee attempt")), /October 2026 is locked/)
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
  await assert.rejects(as(EMP, () => api.diesel.remove(f2.id, "")), /reason/i) // permission passes; the reason is still required
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
    const { profileCall, profileMethods } = await import("./profiles")
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
    const ab = (vehicleId: string, customerId: string, date: string, closingKm: number, quantityLitres: number) => ({ date, vehicleId, customerId, closingKm, quantityLitres, invoiceNo: "", notes: "", source: "STOCK" as const })
    const dX1 = await as(OWNER, () => api.diesel.create(dfill(vX.id, beta.id, day(8), 1000)))
    await as(OWNER, () => api.adblue.create(ab(vX.id, beta.id, day(8), 1000, 5)))
    await as(OWNER, () => api.vehicles.transfer(vX.id, alpha.id, day(6), "Moved to Alpha"))
    const dX2 = await as(OWNER, () => api.diesel.create(dfill(vX.id, alpha.id, day(5), 1400)))
    const aX2 = await as(OWNER, () => api.adblue.create(ab(vX.id, alpha.id, day(5), 1400, 4)))
    await as(OWNER, () => api.diesel.create(dfill(vB.id, beta.id, day(5), 500)))
    const aB = await as(OWNER, () => api.adblue.create(ab(vB.id, beta.id, day(5), 500, 3)))

    // The method list: exactly these, every other api method refused for both profiles (and nothing changes for the others).
    for (const role of ["TATA_ADBLUE", "ADBLUE"] as const) {
      const writes = profileMethods(role).filter((m) => !isReadMethod(m.split(".")[0], m.split(".")[1]))
      assert.deepEqual(writes.sort(), ["adblue.create", "adblue.remove", "adblue.update", "adbluePurchases.create"], `${role}: the only writes: AdBlue entries and bulk purchases`)
    }
    assert.deepEqual(profileMethods("ADBLUE").filter((m) => !profileMethods("TATA_ADBLUE").includes(m)), ["adblueStock.list"], "Tata Adblue: everything Adblue has but the individual draws")
    for (const ns of Object.keys(methods))
      for (const m of Object.keys(methods[ns])) {
        const name = `${ns}.${m}`
        for (const role of ["TATA_ADBLUE", "ADBLUE"] as const) assert.equal(profileCall(role, name, async () => 1) !== null, profileMethods(role).includes(name), `${role}: ${name}`)
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
    const tAdblue = await call<AdBlueEntry[]>(TATA, "adblue.list")
    assert.deepEqual(tAdblue.map((e) => e.id), [aX2.id])
    assert.equal(withRuns(tAdblue)[0].kmRun, 400, "AdBlue KM Run from X's Beta entry")
    const ownerAdblue = await read(OWNER, () => api.adblue.list())
    assert.equal(tAdblue[0].amount, ownerAdblue.find((e) => e.id === aX2.id)!.amount, "the weighted-average cost, computed on every draw")
    // The shared stock: every purchase; the draws only as company-wide totals by month (owner, 11 Nov 2026).
    const tPurchases = await call<AdBluePurchase[]>(TATA, "adbluePurchases.list")
    assert.deepEqual(tPurchases, await read(OWNER, () => api.adbluePurchases.list()))
    await assert.rejects(call(TATA, "adblueStock.list"), /refused by the method list/, "Tata Adblue: no individual draw of anyone, not even its date and litres")
    assert.equal((await call<unknown[]>(ADB, "adblueStock.list")).length, stockDraws(ownerAdblue).length, "Adblue keeps the draw list (unchanged)")
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
    assert.ok(!(await call<AdBlueEntry[]>(TATA, "adblue.list")).some((e) => e.id === bDirect.id), "…never Beta's entry itself")
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
    await assert.rejects(call(TATA, "adblue.remove", tNew.id, ""), /reason/i)
    await call(TATA, "adblue.remove", tNew.id, "Entered twice")
    const tEvents = (await read(DEV, () => api.audit.list())).filter((e) => e.recordId === tNew.id)
    assert.deepEqual(tEvents.map((e) => [e.action, e.actor.role, e.actor.userId]).sort(), [["CREATED", "TATA_ADBLUE", P.TATA], ["DELETED", "TATA_ADBLUE", P.TATA], ["UPDATED", "TATA_ADBLUE", P.TATA]], "audited as Tata Adblue")
    assert.equal(tEvents.find((e) => e.action === "DELETED")!.reason, "Entered twice")
    /** The events of one record: the actor, the vehicle / customer in the snapshots, the litres, a server timestamp. */
    const snapshotsOf = (events: AuditEvent[]) =>
      Object.fromEntries(events.map((e) => [e.action, { name: e.actor.name, before: e.before && [e.before.vehicleId, e.before.customerId, e.before.quantityLitres], after: e.after && [e.after.vehicleId, e.after.customerId, e.after.quantityLitres], date: e.recordDate, reason: e.reason, at: Math.abs(Date.now() - Date.parse(e.at)) < 3_600_000 }]))
    assert.deepEqual(snapshotsOf(tEvents), {
      CREATED: { name: "Tata Person", before: null, after: [vA.id, alpha.id, 2], date: today, reason: null, at: true },
      UPDATED: { name: "Tata Person", before: [vA.id, alpha.id, 2], after: [vA.id, alpha.id, 3], date: today, reason: "Wrong litres", at: true },
      DELETED: { name: "Tata Person", before: [vA.id, alpha.id, 3], after: null, date: today, reason: "Entered twice", at: true },
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
      await assert.rejects(call(id, "adblue.remove", e.id, "Delete in a locked month"), /is locked/, `${id.role}: no delete in a locked month`)
      await sqlAs(id, `update fuel.adblue_entries set quantity_litres = 9 where id = '${e.id}'; delete from fuel.adblue_entries where id = '${e.id}';`) // RLS: month_open
      assert.equal((await read(OWNER, () => api.adblue.list())).find((x) => x.id === e.id)!.quantityLitres, 1, `${id.role}: untouched, also straight in the database`)
    }
    await as(DEV, () => api.monthLocks.set(today.slice(0, 7), "OPEN"))
    await call(TATA, "adblue.remove", tMove.id, "Lock check cleanup")
    await call(ADB, "adblue.remove", aMove.id, "Lock check cleanup")
    await assert.rejects(call(TATA, "adblue.create", ab(vB.id, beta.id, today, 900, 1)), /for this customer/, "Beta's vehicle: refused")
    await assert.rejects(call(TATA, "adblue.create", ab(vB.id, alpha.id, today, 900, 1)), /assigned to BETA/, "…and its customer can't be chosen around")
    await assert.rejects(call(TATA, "adblue.update", aB.id, ab(vB.id, beta.id, day(5), 500, 1)), /for this customer/)
    await assert.rejects(call(TATA, "adblue.remove", aB.id, "Not mine"), /for this customer/)
    await assert.rejects(call(TATA, "adblue.create", ab(vA.id, alpha.id, "2026-10-31", 1500, 1)), /October 2026 is locked/, "the month lock applies")
    const bulk = { date: today, vendorName: "Tata Bulk Vendor", product: "AdBlue", buckets: 2, litresPerBucket: 20, pricePerBucket: 900, invoiceNo: "", notes: "" }
    const tBulk = await call<AdBluePurchase>(TATA, "adbluePurchases.create", bulk)
    assert.equal((await read(OWNER, () => api.adbluePurchases.list())).find((x) => x.id === tBulk.id)!.totalLitres, 40, "into the one shared stock")
    // RLS, even if the server's checks were bypassed: Beta's entries, Diesel, purchases and opening stock stay closed.
    const evSql = (id: string, action = "CREATED") => `insert into audit.events (actor_kind, actor_user_id, actor_role, action, module, record_type, record_id) values ('SESSION', private.current_profile_id(), private.erp_role(), '${action}', 'AdBlue', 'AdBlue entry', '${id}');`
    await assert.rejects(sqlAs(TATA, `insert into fuel.adblue_entries (id, vehicle_id, customer_id, date, closing_km, quantity_litres) values ('adb_rls1', '${vB.id}', '${beta.id}', '${today}', 950, 1); ${evSql("adb_rls1")}`), /row-level security/, "RLS: an ungranted customer")
    await sqlAs(TATA, `insert into fuel.adblue_entries (id, vehicle_id, customer_id, date, closing_km, quantity_litres) values ('adb_rls2', '${vA.id}', '${alpha.id}', '${today}', 2100, 1); ${evSql("adb_rls2")}`)
    await sqlAs(TATA, `update fuel.adblue_entries set notes = 'tampered' where id = '${aB.id}'; delete from fuel.adblue_entries where id = '${aB.id}'; update fuel.adblue_purchases set notes = 'tampered'; delete from fuel.adblue_purchases where opening;`)
    assert.equal((await read(OWNER, () => api.adblue.list())).find((e) => e.id === aB.id)!.notes, "", "RLS: Beta's entry untouched")
    assert.ok((await read(OWNER, () => api.adbluePurchases.list())).every((x) => x.notes !== "tampered") && (await read(OWNER, () => api.adbluePurchases.list())).some((x) => x.opening), "RLS: purchases and opening stock untouched")
    await assert.rejects(sqlAs(TATA, `insert into fuel.adblue_purchases (date, vendor_name, product, buckets, litres_per_bucket, price_per_bucket, opening) values ('${today}', '', 'Opening', 1, 10, 10, true)`), /row-level security/, "RLS: no opening stock")
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
    // Audit and reasons as before: the profiles' entries are recorded as them; deletes still need a reason.
    const evs = await read(OWNER, () => api.audit.history(eEnd.id))
    assert.deepEqual(evs.map((e) => [e.action, e.actor.role]), [["CREATED", "ADBLUE"], ["UPDATED", "TATA_ADBLUE"]], "each recorded as the profile that did it")
    await assert.rejects(call(TATA, "adblue.remove", eLate.id, ""), /reason/i)
    for (const [id, e] of [[TATA, eLate], [ADB, eEnd], [OWNER, oSpare], [OWNER, dEnd], [OWNER, mLate]] as const) await (id === OWNER ? as(OWNER, () => api.adblue.remove(e.id, "Check cleanup")) : call(id, "adblue.remove", e.id, "Check cleanup"))
    for (const m of months) await as(DEV, () => api.monthLocks.set(m, "LOCKED"))

    // Diesel visibility with two granted customers (owner, 12 Nov 2026). Alpha and Gamma granted, Beta not; vehicle X
    // worked for Beta, then Alpha. Every read Tata Adblue can make — what every Diesel screen, search, filter, count and
    // card is built from — holds only Alpha's and Gamma's customers, vehicles and records: nothing names Beta, its vehicle,
    // X's Beta-period records or a vehicle that never worked for a granted customer. The AdBlue totals stay company-wide.
    const gamma = await mkCust("GAMMA")
    const vG = await veh("TN70PG0007", gamma.id)
    const dG = await as(OWNER, () => api.diesel.create(dfill(vG.id, gamma.id, day(4), 700)))
    await grant(DEV, P.TATA, [alpha.id, gamma.id], "Tata contract: Alpha and Gamma")
    const tReads = Object.fromEntries(await Promise.all(profileMethods("TATA_ADBLUE").filter((m) => isReadMethod(m.split(".")[0], m.split(".")[1])).map(async (m) => [m, await call<unknown>(TATA, m)] as const)))
    assert.deepEqual((tReads["customers.list"] as Customer[]).map((c) => c.id).sort(), [alpha.id, gamma.id].sort(), "two granted customers: exactly those two")
    const tFills = tReads["diesel.list"] as DieselEntry[]
    assert.ok(tFills.some((e) => e.id === dG.id) && tFills.some((e) => e.id === dX2.id) && tFills.every((e) => e.customerId === alpha.id || e.customerId === gamma.id), "Diesel: Alpha's and Gamma's fills only")
    const tIdx = buildDieselIndex({ customers: tReads["customers.list"], vehicles: tReads["vehicles.list"], drivers: tReads["drivers.list"], diesel: tFills, trips: [], assignments: tReads["assignments.list"] } as never)
    assert.deepEqual(tIdx.groups.map((g) => g.id).sort(), [alpha.id, gamma.id].sort(), "Diesel landing: only the granted customers' cards (no Beta, no Unallocated)")
    assert.deepEqual(tIdx.groups.find((g) => g.id === gamma.id)!.vehicleIds, [vG.id], "…each with its own vehicles")
    const hits = searchVehicles("TN70P", tReads["vehicles.list"] as never, tReads["assignments.list"] as never, today, today)
    assert.ok(hits.length > 0 && hits.every((h) => h.vehicle.id !== vB.id && h.vehicle.id !== vSpare.id), "vehicle search: never Beta's or another vehicle")
    const tJson = JSON.stringify(tReads)
    for (const x of [beta.id, '"BETA"', vB.id, "TN70PB0002", vSpare.id, "TN70PS0004", dX1.id, aB.id])
      assert.ok(!tJson.includes(x), `no Tata Adblue response names ${x}`)
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
    await call(DEV, "adblue.remove", "adb_rls2", "RLS check cleanup")
    // Adblue: every customer's entries; bulk purchases; Diesel refused.
    const aNew = await call<AdBlueEntry>(ADB, "adblue.create", ab(vB.id, beta.id, today, 900, 1))
    await call(ADB, "adblue.update", aNew.id, ab(vB.id, beta.id, today, 900, 2), "Wrong litres")
    await call(ADB, "adblue.remove", aNew.id, "Check cleanup")
    const aEvents = (await read(DEV, () => api.audit.list())).filter((e) => e.recordId === aNew.id)
    assert.deepEqual(aEvents.map((e) => [e.action, e.actor.kind, e.actor.role, e.actor.userId]).sort(), [["CREATED", "SESSION", "ADBLUE", P.ADB], ["DELETED", "SESSION", "ADBLUE", P.ADB], ["UPDATED", "SESSION", "ADBLUE", P.ADB]], "audited as Adblue, never another role")
    assert.deepEqual(snapshotsOf(aEvents), {
      CREATED: { name: ADB.email, before: null, after: [vB.id, beta.id, 1], date: today, reason: null, at: true },
      UPDATED: { name: ADB.email, before: [vB.id, beta.id, 1], after: [vB.id, beta.id, 2], date: today, reason: "Wrong litres", at: true },
      DELETED: { name: ADB.email, before: [vB.id, beta.id, 2], after: null, date: today, reason: "Check cleanup", at: true },
    }, "Adblue's events: who (no name → the signed-in email), which vehicle and customer, before and after")
    for (const id of [OWNER, EMP]) assert.deepEqual((await read(id, () => api.audit.list())).filter((e) => e.recordId === aNew.id), aEvents, `${id.role} reads Adblue's events`)
    for (const id of [TATA, ADB]) assert.deepEqual(await rowsAs(id, `select id from audit.events where record_id = '${aNew.id}'`), [], `${id.role} reads none of them`)
    await call(ADB, "adbluePurchases.create", { ...bulk, vendorName: "Adblue Bulk Vendor" })
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
    assert.deepEqual(await call(TATA, "adblue.list"), [])
    assert.ok((await read(OWNER, () => api.adblue.list())).some((e) => e.id === aX2.id), "history intact after revocation")
    await grant(DEV, P.TATA, [alpha.id], "Contract renewed") // left in place: the reset scripts below must handle a grant
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
  assert.ok(doc.row_counts["fuel.diesel_entries"] >= 5 && doc.row_counts["billing.invoices"] === 2 && doc.row_counts["core.customers"] === 5) // Minda, TEPL, Alpha, Beta, Gamma (12d)
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
