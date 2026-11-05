/**
 * Runnable check for the November 2026 fresh start: npm run check:fresh-start. Real API on in-memory demo data
 * (nothing touches real browser data), clock fixed at 10 Nov 2026, 10:00 IST — October is closed for Dev / Employee.
 *
 *   1. Opening balances at 31 Oct 2026 — one per tanker (JIO / Office / Mini), a station opening balance, AdBlue
 *      opening stock — never purchases; October's closing is November's opening, each tanker on its own.
 *   2. Vehicle fills from a tanker (Diesel source = JIO / Office / Mini) vs a direct petrol-pump fill: the tanker fill
 *      takes litres out of that tanker only, at the source rate on the fill, and is never another purchase.
 *   3. Edit / delete reverse and re-apply the stock; refused or failed writes change nothing; month lock; audit.
 *   4. No bank balance tracking; fuel station payments (every mode, VT / VTHPL) still reach that station's ledger.
 *   5. Security settings: Next.js ≥ 16.4.3 installed, dev server bound to 127.0.0.1.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { failure, setRole, tankerRecordsOf } from "./test-browser"

const FIXED = new Date("2026-11-10T04:30:00.000Z").getTime()
const RealDate = Date
class FixedDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length) super(...(args as [string]))
    else super(FIXED)
  }
  static now() {
    return FIXED
  }
}
globalThis.Date = FixedDate as DateConstructor

async function main() {
  const { api } = await import("./index")
  const { todayISO, round2 } = await import("@/lib/format")
  const { valueTankers, tankerLedger, tankerMoves, tankerPeriod, loadsAsStationPurchases } = await import("@/domain/tanker")
  const { ledgerFor, stationLedger, openingOf } = await import("@/domain/station-ledger")
  const { inventoryLedger, stockFor, purchasedIn, vendorAnalytics, valueInventory, stockDraws } = await import("@/domain/adblue-inventory")
  const { buildDieselIndex, statsOf } = await import("@/domain/diesel")
  const { writeCollection, AUDIT_KEY } = await import("@/lib/storage/local-store")
  const { hasOwnerAuthority } = await import("@/lib/permissions")
  assert.equal(todayISO(), "2026-11-10")
  const OCT = "2026-10-31"
  const NOV = "2026-11"

  setRole("OWNER")
  const t = { vehicleId: null, capacityLitres: null, notes: "" }
  const jio = await api.tankers.create({ ...t, name: "JIO", regNo: "TN70AX9480" })
  const office = await api.tankers.create({ ...t, name: "Office", regNo: "KA53C0538" })
  const mini = await api.tankers.create({ ...t, name: "Mini", regNo: "KA51AF1429" })
  const ids = [jio.id, office.id, mini.id]

  const records = () => tankerRecordsOf()
  const stockOf = async () => {
    const s = valueTankers(await records()).stock
    return ids.map((id) => s.get(id)?.litres ?? 0)
  }
  const events = async (id: string) => (await api.audit.history(id)).map((e) => e.action) // oldest first
  const counts = async () => ({ diesel: (await api.diesel.list()).length, log: (await api.audit.list()).length })
  /** Σ Fuel Purchased of every real station in a month, from the station ledger (pump fills + tanker loads). */
  const stationsPurchased = async (month: string) => {
    const [diesel, loads, payments, stations, tankers] = [await api.diesel.list(), await api.tankerLoads.list(), await api.payments.list(), await api.fuelStations.list(), await api.tankers.list()]
    const purchases = [...diesel, ...loadsAsStationPurchases(loads, tankers)]
    return round2(stations.filter((s) => !s.isTanker).reduce((tot, s) => tot + ledgerFor(stationLedger(s.id, purchases, payments, month, openingOf(s)), [month]).purchased, 0))
  }

  /* ---------------------------------------------------------------- 1a. Tanker opening stock, one per tanker, never a purchase */
  const octPurchasedBefore = await stationsPurchased("2026-10")
  assert.ok(hasOwnerAuthority("EMPLOYEE"), "the Employee records openings like the Owner (5 Nov 2026)")
  await assert.rejects(api.tankerLoads.createOpening({ tankerId: "tnk_default", date: OCT, litres: 1000, value: 0, notes: "" }), /Choose the tanker/) // no hidden pool absorbs it
  await assert.rejects(api.tankerLoads.createOpening({ tankerId: jio.id, date: "2026-11-11", litres: 1000, value: 0, notes: "" }), /future/)
  await assert.rejects(api.tankerLoads.createOpening({ tankerId: jio.id, date: OCT, litres: 0, value: 0, notes: "" }), /greater than 0/)
  const oJ = await api.tankerLoads.createOpening({ tankerId: jio.id, date: OCT, litres: 1000, value: 95000, notes: "Dip reading" })
  await api.tankerLoads.createOpening({ tankerId: office.id, date: OCT, litres: 500, value: 0, notes: "" }) // value unknown
  await api.tankerLoads.createOpening({ tankerId: mini.id, date: OCT, litres: 200, value: 19000, notes: "" })
  await assert.rejects(api.tankerLoads.createOpening({ tankerId: jio.id, date: OCT, litres: 5, value: 0, notes: "" }), /already has opening stock/)
  await assert.rejects(api.tankerLoads.update(oJ.id, { tankerId: jio.id, date: OCT, stationId: "dv_lakshmitha", invoiceNo: "", litres: 1, rate: 1, notes: "" }), /can't be edited/)
  assert.deepEqual(await stockOf(), [1000, 500, 200])
  assert.equal(await stationsPurchased("2026-10"), octPurchasedBefore) // opening stock is owed to nobody
  assert.deepEqual(await events(oJ.id), ["CREATED"])
  // A tanker with earlier records can't take an opening dated after them (it would not be an opening).
  const fourth = await api.tankers.create({ ...t, name: "Fourth", regNo: "KA01ZZ0004" })
  const l4 = await api.tankerLoads.create({ tankerId: fourth.id, date: "2026-10-20", stationId: "dv_lakshmitha", invoiceNo: "", litres: 100, rate: 95, notes: "" })
  await assert.rejects(api.tankerLoads.createOpening({ tankerId: fourth.id, date: OCT, litres: 10, value: 0, notes: "" }), /already has records before/)
  await api.tankerLoads.remove(l4.id, "Check cleanup") // the Owner may change closed October
  await api.tankers.archive(fourth.id)

  /* ---------------------------------------------------------------- 1b. 31 Oct closing = 1 Nov opening, per tanker */
  const ledgerOf = async (id: string | null) => tankerLedger(tankerMoves(await records()), id, NOV)
  const octOf = async (id: string | null) => tankerPeriod(await ledgerOf(id), ["2026-10"])
  const novOf = async (id: string | null) => tankerPeriod(await ledgerOf(id), [NOV])
  for (const [id, litres] of [[jio.id, 1000], [office.id, 500], [mini.id, 200]] as const) {
    const oct = await octOf(id)
    assert.deepEqual([oct.opening, oct.openingStock, oct.loaded, oct.loadedCost, oct.closing], [0, litres, 0, 0, litres]) // baseline, not a purchase
    assert.equal((await novOf(id)).opening, litres) // carried forward on its own
  }
  const octSnapshot = await Promise.all(ids.map(octOf))

  /* ---------------------------------------------------------------- 2. Fills: direct pump vs JIO / Office / Mini */
  const vehicles = await api.vehicles.list()
  const vehicle = vehicles.find((v) => v.status === "ACTIVE" && v.fuelType === "DIESEL" && v.assignedCustomerId)!
  let odo = Math.max(vehicle.odometerKm, ...(await api.diesel.list()).filter((e) => e.vehicleId === vehicle.id).map((e) => e.odometerKm ?? 0))
  const next = (km = 300) => (odo += km)
  const fill = (litres: number, source: string | null, rate: number, extra: Partial<{ date: string; paymentMode: "CREDIT" | "CASH" }> = {}) => ({
    date: todayISO(),
    vehicleId: vehicle.id,
    customerId: null,
    vendorId: source ? "dv_tanker" : "dv_vishal",
    tankerId: source ?? undefined,
    litres,
    rate,
    odometerKm: next(),
    billNo: "",
    paymentMode: "CREDIT" as const,
    ...extra,
  })

  // Tanker load in November: the purchase (owed to the station).
  const novBefore = await stationsPurchased(NOV)
  await api.tankerLoads.create({ tankerId: jio.id, date: "2026-11-02", stationId: "dv_lakshmitha", invoiceNo: "NOV-1", litres: 2000, rate: 95.5, notes: "" })
  assert.equal(round2((await stationsPurchased(NOV)) - novBefore), round2(2000 * 95.5)) // loading counts as a purchase
  assert.deepEqual(await stockOf(), [3000, 500, 200])

  // Direct petrol pump: as before — a station purchase, tanker stock untouched.
  let p0 = await stationsPurchased(NOV)
  const pump = await api.diesel.create(fill(50, null, 98))
  assert.equal(round2((await stationsPurchased(NOV)) - p0), 4900)
  assert.deepEqual(await stockOf(), [3000, 500, 200])

  // JIO, Office, Mini: each takes litres out of its own tanker only, at the source rate, and buys nothing.
  p0 = await stationsPurchased(NOV)
  const fj = await api.diesel.create(fill(100, jio.id, 95.5))
  assert.deepEqual(await stockOf(), [2900, 500, 200])
  const fo = await api.diesel.create(fill(50, office.id, 96))
  assert.deepEqual(await stockOf(), [2900, 450, 200])
  const fm = await api.diesel.create(fill(20, mini.id, 95))
  assert.deepEqual(await stockOf(), [2900, 450, 180])
  assert.equal(await stationsPurchased(NOV), p0) // no second purchase, no new payable
  const listed = await api.diesel.list()
  const row = (id: string) => listed.find((e) => e.id === id)!
  assert.deepEqual([row(fj.id).amount, row(fo.id).amount, row(fm.id).amount], [9550, 4800, 1900]) // litres × the source rate on the fill
  assert.ok(!row(fj.id).averageCost) // never the weighted average
  assert.deepEqual([row(fj.id).tankerId, row(fo.id).tankerId, row(fm.id).tankerId], ids)
  assert.equal(row(fj.id).customerId, vehicle.assignedCustomerId) // costed to the customer assigned that day

  // The vehicle's KM, consumption and cost include the tanker fill like any fill.
  const ds = {
    settings: await api.settings.get(),
    customers: await api.customers.list(),
    vehicles: await api.vehicles.list(),
    drivers: await api.drivers.list(),
    trips: await api.trips.list(),
    diesel: listed,
    invoices: await api.invoices.list(),
    payments: await api.payments.list(),
    assignments: await api.assignments.list(),
    fuelStations: await api.fuelStations.list(),
    tankerLoads: await api.tankerLoads.list(),
    tankers: await api.tankers.list(),
  }
  const idx = buildDieselIndex(ds as never)
  const st = statsOf(idx, [row(fj.id)])
  assert.deepEqual([st.km, st.litres, st.spend], [300, 100, 9550]) // KM since the pump fill before it
  assert.equal(round2(st.kmpl!), 3)
  assert.equal(statsOf(idx, [row(pump.id), row(fj.id), row(fo.id), row(fm.id)]).spend, round2(4900 + 9550 + 4800 + 1900))

  // Refused writes change nothing: more than the tanker holds, no rate, a non-diesel vehicle.
  const petrol = vehicles.find((v) => v.id !== vehicle.id && v.status === "ACTIVE" && v.assignedCustomerId)!
  await api.vehicles.update(petrol.id, { fuelType: "PETROL" }) // test set-up (audited itself)
  const c0 = await counts()
  await assert.rejects(api.diesel.create(fill(500, mini.id, 95)), /Insufficient tanker inventory in Mini\. Available: 180 L/)
  await assert.rejects(api.diesel.create(fill(10, jio.id, 0)), /source rate/)
  await assert.rejects(api.diesel.create({ ...fill(10, jio.id, 95), vehicleId: petrol.id, odometerKm: petrol.odometerKm + 999_999 }), /doesn't run on diesel/)
  assert.deepEqual(await counts(), c0)
  assert.deepEqual(await stockOf(), [2900, 450, 180])

  // A failed write (the audit write throws) leaves neither the entry nor a stock movement.
  failure.key = AUDIT_KEY
  failure.once = true
  await assert.rejects(api.diesel.create(fill(30, jio.id, 95.5)), /simulated storage failure/)
  assert.deepEqual(await counts(), c0)
  assert.deepEqual(await stockOf(), [2900, 450, 180])

  /* ---------------------------------------------------------------- 3. Edit and delete reverse and re-apply the stock */
  const edit = async (id: string, patch: Partial<ReturnType<typeof fill>>, reason = "Correction") => {
    const e = (await api.diesel.get(id))! // the stored entry as it is now
    return api.diesel.update(id, { date: e.date, vendorId: e.vendorId, litres: e.litres, rate: e.rate, odometerKm: e.odometerKm, billNo: e.billNo, paymentMode: e.paymentMode, tankerId: e.tankerId, ...patch }, reason)
  }
  await edit(fj.id, { litres: 150 })
  assert.deepEqual(await stockOf(), [2850, 450, 180]) // JIO −50 more
  await edit(fj.id, { tankerId: office.id }) // moved to Office: JIO gets its 150 L back
  assert.deepEqual(await stockOf(), [3000, 300, 180])
  await assert.rejects(edit(fj.id, { tankerId: mini.id, litres: 200 }), /Insufficient tanker inventory in Mini/) // 200 L > Mini's 180 L: refused
  assert.deepEqual(await stockOf(), [3000, 300, 180])
  p0 = await stationsPurchased(NOV)
  await edit(fj.id, { vendorId: "dv_vishal", tankerId: undefined, rate: 98 }) // switched to a pump fill: stock back, now a purchase
  assert.deepEqual(await stockOf(), [3000, 450, 180])
  assert.equal(round2((await stationsPurchased(NOV)) - p0), round2(150 * 98))
  await edit(fj.id, { vendorId: "dv_tanker", tankerId: jio.id, rate: 95.5 }) // and back to JIO
  assert.deepEqual(await stockOf(), [2850, 450, 180])
  assert.equal(await stationsPurchased(NOV), p0)
  await api.diesel.remove(fo.id, "Entered twice") // deleting restores Office's litres
  assert.deepEqual(await stockOf(), [2850, 500, 180])
  assert.deepEqual(await events(fj.id), ["CREATED", "UPDATED", "UPDATED", "UPDATED", "UPDATED"])
  assert.deepEqual(await events(fo.id), ["CREATED", "DELETED"])

  /* ---------------------------------------------------------------- 4. Month lock and history */
  setRole("EMPLOYEE")
  const emp = await api.diesel.create(fill(10, jio.id, 95.5)) // Employees record tanker fills (and, like the Owner, may change a locked month)
  assert.deepEqual(await stockOf(), [2840, 500, 180])
  setRole("OWNER")
  // November activity never rewrote October: each tanker's October is exactly the baseline.
  assert.deepEqual(await Promise.all(ids.map(octOf)), octSnapshot)
  const allNov = await novOf(null)
  assert.equal(allNov.opening, 1700) // All tankers = JIO + Office + Mini openings (1,000 + 500 + 200)
  assert.equal(allNov.closing, 2840 + 500 + 180)
  await api.diesel.remove(emp.id, "Check cleanup")

  /* ---------------------------------------------------------------- 5. Fuel station opening balance at 31 Oct */
  setRole("EMPLOYEE") // Owner-level openings (5 Nov 2026): the same rules apply
  await assert.rejects(api.fuelStations.setOpeningBalance("dv_vishal", { amount: 1000, date: OCT }), /already has records before October 2026/) // would be ignored by the ledger
  setRole("OWNER")
  const fresh = await api.fuelStations.create({ name: "Fresh Start Pump" })
  const credit = await api.fuelStations.create({ name: "Advance Paid Pump" })
  await api.fuelStations.setOpeningBalance(fresh.id, { amount: 50000, date: OCT }) // we owe it ₹50,000 on 31 Oct
  await api.fuelStations.setOpeningBalance(credit.id, { amount: -5000, date: OCT }) // it owes us (advance)
  await api.diesel.create({ ...fill(10, null, 100), vendorId: fresh.id }) // ₹1,000 bought in November
  await api.fuelStationPayments.create({ stationId: fresh.id, paymentDate: todayISO(), amount: 20000, paymentMode: "NEFT", notes: "", companyCode: vehicle.companyCode, forMonth: "2026-10" })
  const ledgerRows = async (s: string) => {
    const [diesel, loads, payments, stations, tankers] = [await api.diesel.list(), await api.tankerLoads.list(), await api.payments.list(), await api.fuelStations.list(), await api.tankers.list()]
    return stationLedger(s, [...diesel, ...loadsAsStationPurchases(loads, tankers)], payments, NOV, openingOf(stations.find((x) => x.id === s)!))
  }
  const fr = await ledgerRows(fresh.id)
  const [oct, nov] = [ledgerFor(fr, ["2026-10"]), ledgerFor(fr, [NOV])]
  assert.deepEqual([oct.opening, oct.purchased, oct.paid, oct.closing], [50000, 0, 0, 50000]) // October = the baseline only
  assert.deepEqual([nov.opening, nov.purchased, nov.paid, nov.closing], [50000, 1000, 20000, 31000]) // Closing = Opening + Purchased − Paid
  assert.equal(ledgerFor(await ledgerRows(credit.id), [NOV]).opening, -5000)
  assert.deepEqual(await events(fresh.id), ["CREATED", "UPDATED"])
  await api.fuelStations.setOpeningBalance(credit.id, { amount: 0, date: OCT }) // 0 removes it
  assert.equal(openingOf((await api.fuelStations.get(credit.id))!), undefined)

  /* ---------------------------------------------------------------- 6. AdBlue opening stock (owner, 3 Nov 2026 — reverses the 31 Oct removal) */
  writeCollection("adblue_purchases", [])
  writeCollection("adblue_entries", [])
  setRole("EMPLOYEE")
  await assert.rejects(api.adbluePurchases.createOpening({ date: OCT, litres: 100, value: 0, notes: "" }), /value of the stock/) // the Employee records it too (5 Nov 2026); draws are costed from it
  setRole("OWNER")
  await assert.rejects(api.adbluePurchases.createOpening({ date: "2026-11-11", litres: 100, value: 9000, notes: "" }), /future/)
  const abOpen = await api.adbluePurchases.createOpening({ date: OCT, litres: 100, value: 9000, notes: "On hand at go-live" })
  assert.deepEqual([abOpen.opening, abOpen.totalLitres, abOpen.totalCost, abOpen.vendorName], [true, 100, 9000, ""])
  await assert.rejects(api.adbluePurchases.createOpening({ date: OCT, litres: 1, value: 1, notes: "" }), /already recorded/)
  await assert.rejects(api.adbluePurchases.update(abOpen.id, { date: OCT, vendorName: "X", product: "", buckets: 1, litresPerBucket: 1, pricePerBucket: 1, invoiceNo: "", notes: "" }), /can't be edited/)
  // Bulk purchases still add stock and are "AdBlue Purchased"; draws are costed at the weighted average (opening included).
  const bulk = await api.adbluePurchases.create({ date: "2026-11-02", vendorName: "Bulk Vendor", product: "AdBlue", buckets: 10, litresPerBucket: 20, pricePerBucket: 900, invoiceNo: "", notes: "" })
  assert.deepEqual([bulk.totalLitres, bulk.totalCost], [200, 9000])
  const draw = await api.adblue.create({ date: todayISO(), vehicleId: vehicle.id, customerId: null, closingKm: odo + 10, quantityLitres: 15, invoiceNo: "", notes: "", source: "STOCK" })
  let purchases = await api.adbluePurchases.list()
  let draws = stockDraws(await api.adblue.list())
  const v = valueInventory(purchases, draws)
  assert.deepEqual([v.stockLitres, v.stockValue, v.costOf.get(draw.id)], [285, 17100, 900]) // (9,000 + 9,000) / 300 L = ₹60/L
  const novBought = purchasedIn(purchases, (p) => p.date.startsWith(NOV))
  assert.deepEqual([novBought.litres, novBought.cost], [200, 9000])
  // Opening stock is stock, never a purchase.
  purchases = await api.adbluePurchases.list()
  draws = stockDraws(await api.adblue.list())
  const led = inventoryLedger(purchases, draws, NOV)
  const [aOct, aNov] = [stockFor(led, ["2026-10"]), stockFor(led, [NOV])]
  assert.deepEqual([aOct.opening, aOct.openingStock, aOct.purchased, aOct.closing], [0, 100, 0, 100])
  assert.deepEqual([aNov.opening, aNov.purchased, aNov.consumed, aNov.closing], [100, 200, 15, 285]) // October closing → November opening
  assert.equal(purchasedIn(purchases, (p) => p.date.startsWith("2026-10")).cost, 0) // never "AdBlue Purchased"
  assert.deepEqual(vendorAnalytics(purchases).map((x) => x.vendor), ["Bulk Vendor"])

  /* ---------------------------------------------------------------- 7. No bank balance tracking (owner, 31 Oct 2026) */
  const analytics = await import("@/domain/analytics")
  assert.ok(!("bankBalance" in analytics), "no bank balance calculation")
  const cash = analytics.cashFlow(ds as never, { from: "2026-11-01", to: "2026-11-30" })
  assert.deepEqual(Object.keys(cash).sort(), ["outflows", "receipts", "totalOut"]) // receipts and payments only — no opening / closing bank
  const { DEFAULT_SETTINGS } = await import("@/lib/storage/seed")
  for (const co of DEFAULT_SETTINGS.companies) assert.ok(!("openingBalance" in co) && !("openingBalanceDate" in co), `${co.code} has no bank opening balance`)
  const { readdirSync, statSync } = await import("node:fs")
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(`${dir}/${f}`).isDirectory() ? files(`${dir}/${f}`) : /\.tsx?$/.test(f) ? [`${dir}/${f}`] : []))
  for (const f of ["src/app", "src/features", "src/components"].flatMap(files))
    assert.ok(!/bank balance|opening bank|closing bank|bankBalance/i.test(readFileSync(f, "utf8")), `${f} shows no bank balance`)
  // Pump payments still work in every mode and land in that pump's ledger (paid by VT or VTHPL).
  const before7 = ledgerFor(await ledgerRows(fresh.id), [NOV])
  await api.fuelStationPayments.create({ stationId: fresh.id, paymentDate: todayISO(), amount: 1500, paymentMode: "UPI", notes: "", companyCode: "VTHPL", forMonth: NOV })
  await api.fuelStationPayments.create({ stationId: fresh.id, paymentDate: todayISO(), amount: 500, paymentMode: "CASH", notes: "Paid at the office", companyCode: "VT", forMonth: NOV })
  const after7 = ledgerFor(await ledgerRows(fresh.id), [NOV])
  assert.deepEqual([after7.opening, after7.purchased, after7.paid, after7.closing], [before7.opening, before7.purchased, round2(before7.paid + 2000), round2(before7.closing - 2000)]) // Opening + Purchased − Paid = Closing
  assert.equal(after7.closing, 29000)
  const vouchers = (await api.fuelStationPayments.list()).filter((x) => x.stationId === fresh.id)
  assert.deepEqual(vouchers.map((x) => `${x.paymentMode}:${x.companyCode}:${x.amount}`).sort(), ["CASH:VT:500", `NEFT:${vehicle.companyCode}:20000`, "UPI:VTHPL:1500"].sort())

  /* ---------------------------------------------------------------- 8. Security settings */
  const nextVersion = JSON.parse(readFileSync("node_modules/next/package.json", "utf8")).version as string
  const [maj, min, pat] = nextVersion.split(".").map(Number)
  assert.ok(maj === 16 && (min > 4 || (min === 4 && pat >= 3)), `Next.js ${nextVersion} is patched (≥ 16.4.3, still 16.x)`)
  const pkg = JSON.parse(readFileSync("package.json", "utf8"))
  assert.equal(pkg.dependencies.next, nextVersion)
  assert.equal(pkg.devDependencies["eslint-config-next"], nextVersion)
  assert.match(pkg.scripts.dev, /-H 127\.0\.0\.1/) // the dev server listens on this computer only
  assert.equal(pkg.scripts.build, "next build") // Vercel builds as before

  console.log("fresh start (31 Oct baseline → November), tanker-sourced vehicle fills and security settings: all checks passed")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
