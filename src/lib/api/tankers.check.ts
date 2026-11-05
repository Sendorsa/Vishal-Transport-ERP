/**
 * Runnable check for multiple tankers, tanker-fill costing, AdBlue direct purchases and fuel TDS:
 * npm run check:tankers. Real API on in-memory demo data, with the clock fixed at 1 Oct 2026 (September's TDS is
 * due; there is no payment grace period since 31 Oct 2026 — the Monthly Sheet Lock alone decides who may back-date).
 *
 * Answers 14 (TDS), 23 (tanker fills at the rate on the fill), 24 (several tankers), 25 (direct AdBlue).
 */
import assert from "node:assert/strict"
import { setRole, storage, tankerRecordsOf } from "./test-browser"

// Fixed clock: `new Date()` / Date.now() = 1 Oct 2026, 10:00 IST. Dates given explicitly are untouched.
const FIXED = new Date("2026-10-01T04:30:00.000Z").getTime()
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
  const { valueTankers, tankerLedger, tankerMoves, tankerPeriod } = await import("@/domain/tanker")
  const { valueInventory, stockDraws } = await import("@/domain/adblue-inventory")
  const { ledgerFor, stationLedger, tdsDue } = await import("@/domain/station-ledger")
  const { loadsAsStationPurchases } = await import("@/domain/tanker")
  assert.equal(todayISO(), "2026-10-01")

  setRole("OWNER")
  const blank = { vehicleId: null, capacityLitres: 12000, notes: "" }

  /* ---------------------------------------------------------------- 1. Tanker master: three, then a fourth */
  const a = await api.tankers.create({ ...blank, name: "Tanker TN70AX9480", regNo: "TN70AX9480" })
  const b = await api.tankers.create({ ...blank, name: "Tanker KA53C0538", regNo: "ka 53 c 0538" })
  const c = await api.tankers.create({ ...blank, name: "Tanker KA51AF1429", regNo: "KA51AF1429", capacityLitres: null })
  assert.equal(b.regNo, "KA53C0538") // registrations normalised
  await assert.rejects(api.tankers.create({ ...blank, name: "Another", regNo: "TN 70 AX 9480" }), /already exists/) // duplicate registration
  await assert.rejects(api.tankers.create({ ...blank, name: "tanker tn70ax9480", regNo: "KA01XX0001" }), /already exists/) // duplicate name
  await assert.rejects(api.tankers.create({ ...blank, name: "No registration", regNo: " " }), /registration number/) // a blank one would be a stock pool
  await assert.rejects(api.tankers.update(a.id, { ...blank, name: a.name, regNo: "" }), /registration number/) // and can't be removed
  await assert.rejects(api.tankers.create({ ...blank, name: "Bad", regNo: "X1", capacityLitres: -5 }), /Capacity/)
  const d = await api.tankers.create({ ...blank, name: "Fourth Tanker", regNo: "KA01ZZ0004" }) // no code or schema change needed
  assert.equal((await api.tankers.list()).length, 4)
  await api.tankers.update(c.id, { ...blank, name: "Mini Tanker KA51AF1429", regNo: "KA51AF1429", capacityLitres: 3000 })
  assert.equal((await api.tankers.get(c.id))!.capacityLitres, 3000)
  setRole("EMPLOYEE")
  await assert.rejects(api.tankers.create({ ...blank, name: "Nope", regNo: "KA51AF1429" }), /already/) // the Employee manages tankers like the Owner (5 Nov 2026); duplicates still refused
  setRole("OWNER")

  /* ---------------------------------------------------------------- 2. Every load / dispense names its tanker; stock is per tanker */
  const today = todayISO()
  const vehicles = await api.vehicles.list()
  const vehicle = vehicles.find((v) => v.status === "ACTIVE" && v.fuelType === "DIESEL" && v.assignedCustomerId)!
  const odo0 = Math.max(vehicle.odometerKm, ...(await api.diesel.list()).filter((e) => e.vehicleId === vehicle.id).map((e) => e.odometerKm ?? 0))
  await assert.rejects(api.tankerLoads.create({ tankerId: "", date: today, stationId: "dv_lakshmitha", invoiceNo: "", litres: 100, rate: 95, notes: "" }), /Choose the tanker/)
  const la = await api.tankerLoads.create({ tankerId: a.id, date: "2026-09-02", stationId: "dv_lakshmitha", invoiceNo: "L-A", litres: 3000, rate: 94.5, notes: "" })
  const lb = await api.tankerLoads.create({ tankerId: b.id, date: "2026-09-03", stationId: "dv_raghuveer", invoiceNo: "L-B", litres: 1000, rate: 95, notes: "" })
  const fill = (litres: number, odometerKm: number, tankerId: string, rate: number) => ({ date: "2026-09-10", vehicleId: vehicle.id, customerId: null, vendorId: "dv_tanker", tankerId, litres, rate, odometerKm, billNo: "", paymentMode: "CREDIT" as const })
  // Tanker C has no stock — the fill is refused even though A and B have plenty (stocks never mix).
  await assert.rejects(api.diesel.create(fill(50, odo0 + 100, c.id, 95)), /Insufficient tanker inventory in Mini Tanker KA51AF1429\. Available: 0 L/)
  await assert.rejects(api.diesel.create(fill(50, odo0 + 100, "", 95)), /Choose the tanker/)
  const fa = await api.diesel.create(fill(200, odo0 + 100, a.id, 98.81))
  // A new tanker fill must carry its source rate — never saved rate-less, so never costed at the average (31 Oct 2026).
  await assert.rejects(api.diesel.create({ ...fill(100, odo0 + 250, b.id, 0), date: "2026-09-11" }), /source rate/)
  // Older records saved without a rate still exist (imports): written as stored data, they read at the weighted average.
  const { readCollection: readCol, writeCollection: writeCol } = await import("@/lib/storage/local-store")
  const fb = { ...fill(100, odo0 + 250, b.id, 0), date: "2026-09-11", id: "dsl_legacy_norate", companyCode: vehicle.companyCode, customerId: vehicle.assignedCustomerId, amount: 0, createdAt: "2026-09-11T10:00:00.000Z", updatedAt: "2026-09-11T10:00:00.000Z" }
  writeCol("diesel_entries", [...readCol("diesel_entries"), fb as never])
  const ext = await api.tankerDispenses.create({ tankerId: b.id, date: "2026-09-12", vehicleNo: "KA01AB1234", litres: 50, notes: "Hired truck" })
  await assert.rejects(api.tankerDispenses.create({ tankerId: b.id, date: "2026-09-12", vehicleNo: "KA01AB1234", litres: 900, notes: "" }), /Insufficient tanker inventory in Tanker KA53C0538/)
  const stock = async () => valueTankers(await tankerRecordsOf()).stock
  let s = await stock()
  assert.deepEqual([a.id, b.id, c.id, d.id].map((id) => s.get(id)?.litres ?? 0), [2800, 850, 0, 0])

  /* ---------------------------------------------------------------- 3. Answer 23: a fill's amount = litres × the rate on the fill */
  const listed = await api.diesel.list()
  assert.equal(listed.find((e) => e.id === fa.id)!.amount, round2(200 * 98.81)) // the source / typed rate, not the tanker's ₹94.50 average
  assert.equal(listed.find((e) => e.id === fb.id)!.amount, 9500) // no rate → B's average (₹95) × 100 L
  assert.equal(listed.find((e) => e.id === fb.id)!.averageCost, true)
  // Purchase cost (loads, owed to the station) is a different figure from the fill amount.
  const purchases = [...listed, ...loadsAsStationPurchases(await api.tankerLoads.list())]
  const sepPurchased = (list: typeof purchases) => ledgerFor(stationLedger("dv_lakshmitha", list, []), ["2026-09"]).purchased
  assert.equal(round2(sepPurchased(purchases) - sepPurchased(purchases.filter((x) => x.id !== la.id))), round2(3000 * 94.5)) // the load is its purchase cost

  /* ---------------------------------------------------------------- 4. Transfers: between tankers, never a purchase */
  await assert.rejects(api.tankerTransfers.create({ date: "2026-09-15", fromTankerId: a.id, toTankerId: a.id, litres: 10, notes: "" }), /two different tankers/)
  await assert.rejects(api.tankerTransfers.create({ date: "2026-09-15", fromTankerId: c.id, toTankerId: a.id, litres: 10, notes: "" }), /Insufficient tanker inventory in Mini Tanker/)
  const tr = await api.tankerTransfers.create({ date: "2026-09-15", fromTankerId: a.id, toTankerId: c.id, litres: 500, notes: "Top up the mini tanker" })
  s = await stock()
  assert.deepEqual([s.get(a.id)!.litres, s.get(c.id)!.litres], [2300, 500])
  const r = await tankerRecordsOf()
  const sep = (id: string | null) => tankerPeriod(tankerLedger(tankerMoves(r), id, "2026-10"), ["2026-09"])
  assert.deepEqual([sep(a.id).transferOut, sep(c.id).transferIn, sep(null).transferIn, sep(null).loadedCost], [500, 500, 0, round2(3000 * 94.5 + 1000 * 95)]) // company total unchanged
  // C dispenses some of it — deleting the transfer would now make C negative: refused.
  const fc = await api.diesel.create({ ...fill(100, odo0 + 400, c.id, 98.81), date: "2026-09-16" })
  await assert.rejects(api.tankerTransfers.remove(tr.id, "Wrong tanker"), /Insufficient tanker inventory in Mini Tanker/)
  await api.diesel.remove(fc.id, "Check cleanup")
  await api.tankerTransfers.remove(tr.id, "Wrong tanker")
  s = await stock()
  assert.deepEqual([s.get(a.id)!.litres, s.get(c.id)?.litres ?? 0], [2800, 0])
  // Restore / Push Back of the deleted transfer (Owner): same id, stock moves again.
  const delEvent = (await api.audit.history(tr.id)).at(-1)!
  assert.equal(delEvent.action, "DELETED")
  await api.audit.restoreDeleted(delEvent.id, "Transfer was correct")
  assert.equal((await stock()).get(c.id)!.litres, 500)

  /* ---------------------------------------------------------------- 5. Stock adjustments: reason mandatory, never below zero */
  await assert.rejects(api.tankerAdjustments.create({ date: "2026-09-30", tankerId: b.id, litres: -10, reason: " " }), /reason for adjusting stock/)
  await assert.rejects(api.tankerAdjustments.create({ date: "2026-09-30", tankerId: b.id, litres: -900, reason: "Dip reading" }), /Insufficient tanker inventory in Tanker KA53C0538/)
  const adj = await api.tankerAdjustments.create({ date: "2026-09-30", tankerId: b.id, litres: -12.5, reason: "Dip reading 30 Sep: 12.5 L less" })
  assert.equal((await stock()).get(b.id)!.litres, 837.5)
  const adjEvents = await api.audit.history(adj.id)
  assert.deepEqual([adjEvents[0].action, adjEvents[0].reason], ["CREATED", "Dip reading 30 Sep: 12.5 L less"])
  setRole("EMPLOYEE")
  await assert.rejects(api.tankerAdjustments.remove(adj.id, ""), /reason/) // the Employee may delete (5 Nov 2026), with a reason like everyone
  setRole("OWNER")

  /* ---------------------------------------------------------------- 6. Archive / restore keeps history */
  await api.tankers.archive(d.id)
  await assert.rejects(api.tankerLoads.create({ tankerId: d.id, date: today, stationId: "dv_lakshmitha", invoiceNo: "", litres: 10, rate: 95, notes: "" }), /archived/)
  await api.tankers.archive(b.id)
  // B's history is still there and still counted; editing B's existing dispense still works.
  assert.equal((await stock()).get(b.id)!.litres, 837.5)
  await api.tankerDispenses.update(ext.id, { tankerId: b.id, date: "2026-09-12", vehicleNo: "KA01AB1234", litres: 40, notes: "Hired truck" }, "Wrong litres")
  assert.equal((await stock()).get(b.id)!.litres, 847.5)
  await api.tankers.restore(b.id)
  assert.deepEqual((await api.audit.history(b.id)).map((e) => e.action), ["CREATED", "ARCHIVED", "RESTORED"])
  assert.equal((await api.tankers.list()).length, 4) // never deleted

  /* ---------------------------------------------------------------- 7. A tanker's own fuel never comes from tanker cargo */
  const ownVehicle = vehicles.find((v) => v.status === "ACTIVE" && v.id !== vehicle.id)!
  await api.tankers.update(a.id, { ...blank, name: "Tanker TN70AX9480", regNo: "TN70AX9480", vehicleId: ownVehicle.id })
  await assert.rejects(api.diesel.create({ ...fill(10, ownVehicle.odometerKm + 10, b.id, 95), vehicleId: ownVehicle.id }), /own fuel isn't taken from tanker cargo/)
  await assert.rejects(api.tankers.update(b.id, { ...blank, name: "Tanker KA53C0538", regNo: "KA53C0538", vehicleId: ownVehicle.id }), /already linked/)

  /* ---------------------------------------------------------------- 8. AdBlue: direct vendor purchase never touches bulk stock */
  const bulk = () => Promise.all([api.adbluePurchases.list(), api.adblue.list()]).then(([p, e]) => valueInventory(p, stockDraws(e)).stockLitres)
  const stock0 = await bulk()
  const purchases0 = (await api.adbluePurchases.list()).length
  const base = { vehicleId: vehicle.id, customerId: null, date: "2026-09-20", invoiceNo: "INV-77", notes: "" }
  await assert.rejects(api.adblue.create({ ...base, closingKm: odo0 + 500, quantityLitres: 20, source: "DIRECT", vendorName: " ", rate: 95 }), /vendor/)
  await assert.rejects(api.adblue.create({ ...base, closingKm: odo0 + 500, quantityLitres: 20, source: "DIRECT", vendorName: "Rajaram Automobiles", rate: 0 }), /rate/)
  const direct = await api.adblue.create({ ...base, closingKm: odo0 + 500, quantityLitres: 20, source: "DIRECT", vendorName: "Rajaram Automobiles", rate: 95.5, paymentMode: "CASH" })
  assert.equal(direct.amount, 1910)
  assert.equal(await bulk(), stock0) // bulk stock unchanged — even if bulk stock is 0, a direct purchase is allowed
  assert.equal((await api.adbluePurchases.list()).length, purchases0) // no bulk purchase created
  const viaList = (await api.adblue.list()).find((e) => e.id === direct.id)!
  assert.deepEqual([viaList.amount, viaList.source, viaList.vendorName], [1910, "DIRECT", "Rajaram Automobiles"]) // its own cost, not the stock average
  await api.adblue.update(direct.id, { ...base, closingKm: odo0 + 500, quantityLitres: 25, source: "DIRECT", vendorName: "Rajaram Automobiles", rate: 95.5, paymentMode: "UPI" }, "Wrong litres")
  assert.equal((await api.adblue.list()).find((e) => e.id === direct.id)!.amount, round2(25 * 95.5))
  await api.adblue.remove(direct.id, "Check cleanup")
  const adDel = (await api.audit.history(direct.id)).at(-1)!
  await api.audit.restoreDeleted(adDel.id, "Was correct")
  assert.equal((await api.adblue.list()).find((e) => e.id === direct.id)!.amount, round2(25 * 95.5))
  assert.equal(await bulk(), stock0)

  /* ---------------------------------------------------------------- 9. TDS: 0.1% of the month, dated its last day, once per station-month */
  const station = "dv_lakshmitha"
  const ledSep = () => api.diesel.list().then(async (dl) => ledgerFor(stationLedger(station, [...dl, ...loadsAsStationPurchases(await api.tankerLoads.list())], await api.payments.list(), "2026-10"), ["2026-09"]))
  const before = await ledSep()
  const due = tdsDue(before.purchased)
  const paidOut0 = (await api.payments.list()).filter((p) => p.direction === "OUT").reduce((t, p) => t + p.amount, 0)
  const tds = await api.fuelStationPayments.recordTds({ stationId: station, month: "2026-09", amount: due, companyCode: "VT", notes: "" })
  assert.deepEqual([tds.date, tds.amount, tds.tdsAmount, tds.mode, tds.forMonth], ["2026-09-30", 0, due, "TDS", "2026-09"]) // paid against its own month
  const after = await ledSep()
  assert.deepEqual([round2(after.paid - before.paid), round2(before.closing - after.closing), after.tds], [due, due, due])
  assert.equal((await api.payments.list()).filter((p) => p.direction === "OUT").reduce((t, p) => t + p.amount, 0), paidOut0) // a TDS entry pays no money out
  await assert.rejects(api.fuelStationPayments.recordTds({ stationId: station, month: "2026-09", amount: 1, companyCode: "VT", notes: "" }), /already recorded/)
  await assert.rejects(api.fuelStationPayments.recordTds({ stationId: station, month: "2026-10", amount: 1, companyCode: "VT", notes: "" }), /dated 31-10-2026|record it on or after/) // month not over
  // An older month's TDS: no grace period any more — Owner-level authority (Owner, Dev, Employee) may record it.
  setRole("EMPLOYEE")
  const augTds = await api.fuelStationPayments.recordTds({ stationId: station, month: "2026-08", amount: 1, companyCode: "VT", notes: "" })
  setRole("OWNER")
  assert.deepEqual([augTds.date, augTds.forMonth], ["2026-08-31", "2026-08"])
  const stp = (await api.fuelStationPayments.list()).find((p) => p.id === tds.id)!
  assert.deepEqual([stp.tds, stp.amount], [true, due])
  await api.fuelStationPayments.update(tds.id, { paymentDate: "2026-09-30", amount: Math.ceil(due), paymentMode: "TDS", notes: "Rounded on the challan" }, "Challan amount")
  assert.equal((await ledSep()).tds, Math.ceil(due))
  await assert.rejects(api.fuelStationPayments.update(tds.id, { paymentDate: "2026-09-29", amount: 5, paymentMode: "TDS", notes: "" }), /last day of its month/)

  /* ---------------------------------------------------------------- 10. Migration: single-tanker data gets one default tanker, nothing lost */
  {
    const { readCollection, writeCollection, migrateStorage } = await import("@/lib/storage/local-store")
    const loads = readCollection("tanker_loads")
    writeCollection("tanker_loads", [...loads, { id: "tkl_legacy", date: "2026-09-01", stationId: "dv_lakshmitha", invoiceNo: "", litres: 77, rate: 90, amount: 6930, notes: "", createdAt: "2026-09-01T00:00:00Z", updatedAt: "" }])
    migrateStorage(true)
    assert.ok(readCollection("tankers").some((t) => t.id === "tnk_default"))
    assert.equal(readCollection("tanker_loads").find((l) => l.id === "tkl_legacy")!.tankerId, "tnk_default")
    assert.equal(readCollection("tanker_loads").filter((l) => l.tankerId === a.id).length, 1) // stamped records keep their tanker
    assert.equal(readCollection("tanker_loads").length, loads.length + 1) // nothing dropped
    migrateStorage(true) // idempotent
    assert.equal(readCollection("tankers").filter((t) => t.id === "tnk_default").length, 1)
  }

  /* ---------------------------------------------------------------- 11. A data-format change never replaces real data with demo data */
  {
    const { ensureSeeded } = await import("./bootstrap")
    const { readMeta, writeMeta, readCollection } = await import("@/lib/storage/local-store")
    for (const source of ["RESTORED", "EMPTY", undefined] as const) {
      writeMeta({ version: 1, seededAt: "", source })
      const n = readCollection("tankers").length
      ensureSeeded()
      assert.equal(readCollection("tankers").length, n, `meta.source ${source}: data kept`)
      assert.equal(readMeta()!.version, (await import("@/lib/storage/local-store")).SCHEMA_VERSION)
    }
    // Demo data a user has written to since the last reset (this check's own API calls) is real data too.
    writeMeta({ version: 1, seededAt: "", source: "DEMO" })
    const n = readCollection("tankers").length
    ensureSeeded()
    assert.equal(readCollection("tankers").length, n, "typed-into demo data: kept")
    assert.equal(readMeta()!.source, undefined, "typed-into demo data: no longer marked DEMO")
    // A lost meta key with data still present: kept, never re-seeded.
    storage.removeItem("vt:meta")
    ensureSeeded()
    assert.equal(readCollection("tankers").length, n, "data without meta: kept")
  }

  /* ---------------------------------------------------------------- 12. The three confirmed tankers (JIO, Office, Mini) */
  {
    const { readCollection, writeCollection, migrateStorage, readAuditEvents } = await import("@/lib/storage/local-store")
    const { CONFIRMED_TANKERS, isStockPool } = await import("@/domain/tanker")
    const { stationSummary } = await import("@/domain/fuel-stations")
    const stock = async () => [...valueTankers(await tankerRecordsOf()).stock].map(([id, s]) => [id, round2(s.litres), round2(s.value)])
    const tankerIds = () => [...readCollection("tanker_loads"), ...readCollection("tanker_dispenses"), ...readCollection("diesel_entries")].map((r) => `${r.id}:${r.tankerId ?? ""}`)
    const kept = readCollection("tankers")
    // Data without the tanker vehicles (demo data): nothing is added.
    migrateStorage(true)
    assert.deepEqual(readCollection("tankers"), kept)

    // The browser's FY import: every tanker record in one pool without a registration, the three tankers only as vehicles.
    const pool = { ...kept.find((t) => t.id === "tnk_default")!, name: "Diesel Tanker", regNo: "", vehicleId: null }
    writeCollection("tankers", [pool, ...kept.filter((t) => t.id !== "tnk_default" && !CONFIRMED_TANKERS.some((c) => c.regNo === t.regNo))])
    const template = readCollection("vehicles")[0]
    const vehicleIds = CONFIRMED_TANKERS.map((c, i) => `veh_tanker_${i}`)
    writeCollection("vehicles", [...readCollection("vehicles"), ...CONFIRMED_TANKERS.map((c, i) => ({ ...template, id: vehicleIds[i], regNo: i === 1 ? "KA 53 C 0538" : c.regNo }))])
    const before = { stock: await stock(), ids: tankerIds(), events: readAuditEvents().length }
    migrateStorage(true)
    const tankers = readCollection("tankers")
    for (const [i, c] of CONFIRMED_TANKERS.entries()) {
      const t = tankers.find((x) => x.id === c.id)!
      assert.deepEqual([t.name, t.regNo, t.vehicleId, t.status], [c.name, c.regNo, vehicleIds[i], "ACTIVE"], `${c.name} added and linked`)
    }
    assert.equal(tankers.filter((t) => !isStockPool(t) && t.status === "ACTIVE" && CONFIRMED_TANKERS.some((c) => c.id === t.id)).length, 3)
    assert.deepEqual(tankers.find((t) => t.id === "tnk_default"), pool) // the pool is untouched
    // Nothing new goes into the pool (it is hidden from the Diesel Tankers page, DIESEL_TANKER_CLEANUP_REPORT.md).
    await assert.rejects(api.tankerLoads.create({ tankerId: "tnk_default", date: "2026-09-30", stationId: "dv_lakshmitha", invoiceNo: "", litres: 10, rate: 95, notes: "" }), /Choose the tanker/)
    await assert.rejects(api.tankerAdjustments.create({ tankerId: "tnk_default", date: "2026-09-30", litres: 5, reason: "Dip reading" }), /Choose the tanker/)
    assert.deepEqual(tankerIds(), before.ids) // no record changes tanker — history is never moved by guess
    assert.deepEqual(await stock(), before.stock) // every tanker's stock and value unchanged
    const events = readAuditEvents().slice(before.events)
    assert.deepEqual(events.map((e) => [e.action, e.recordId, e.actor.kind]), CONFIRMED_TANKERS.map((c) => ["CREATED", c.id, "SYSTEM"]))
    migrateStorage(true) // idempotent: nothing added, nothing logged twice
    assert.equal(readCollection("tankers").length, tankers.length)
    assert.equal(readAuditEvents().length, before.events + 3)
    // A linked tanker's own vehicle record: its historical self-fill from cargo stays editable; a new one is refused.
    const self = { date: "2026-09-30", vehicleId: vehicleIds[0], customerId: template.assignedCustomerId, vendorId: "dv_tanker", tankerId: "tnk_default", litres: 1, rate: 90, odometerKm: null, billNo: "", paymentMode: "CREDIT" as const }
    await assert.rejects(api.diesel.create(self), /own fuel isn't taken from tanker cargo/)
    setRole("OWNER")
    const old = readCollection("diesel_entries").find((e) => e.vendorId === "dv_tanker" && e.rate > 0)!
    writeCollection("tankers", readCollection("tankers").map((t) => (t.id === CONFIRMED_TANKERS[2].id ? { ...t, vehicleId: old.vehicleId } : t)))
    const edited = await api.diesel.update(old.id, { date: old.date, vendorId: old.vendorId, litres: old.litres, rate: old.rate, odometerKm: old.odometerKm, billNo: "EDITED", paymentMode: old.paymentMode, tankerId: old.tankerId })
    assert.deepEqual([edited.billNo, edited.tankerId, edited.litres], ["EDITED", old.tankerId, old.litres]) // recorded history stays editable

    // Vehicles Served counts real vehicles only, even when a tanker load carries its tanker's vehicle.
    const txn = (id: string, vehicleId: string) => ({ id, date: "2026-09-01", vehicleId, customerId: null, kind: "DIESEL" as const, qty: 10, rate: 90, amount: 900 })
    assert.equal(stationSummary([txn("tkl_x", vehicleIds[0]), txn("dsl_x", "veh_a")]).vehiclesServed, 1)
  }

  assert.ok(storage.getItem("vt:tankers"))
  void la
  void lb
  console.log("tankers, tanker costing, AdBlue direct purchases and fuel TDS: all checks passed")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
