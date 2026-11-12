/**
 * Runnable check for Industrial Diesel Supply (owner, 12 Nov 2026):  npm run check:industrial
 * Real API on in-memory demo data (nothing touches real browser data), clock fixed at 10 Nov 2026, 10:00 IST
 * (October is closed for the Employee; the Owner and Dev may still change it).
 *
 *   1. Create from one tanker and split across two: amount = litres × rate, the litres out of each tanker.
 *   2. Allocations must add up exactly; one tanker once; active company tankers only.
 *   3. Stock: never beyond what a tanker holds on the date (later records kept covered), never negative; a failed
 *      allocation or storage write saves nothing.
 *   4. Edit: original litres back first, then the new ones; change tankers and litres; refused edits change nothing.
 *   5. Delete returns the litres once (a second delete does nothing); Restore takes them again, once.
 *   6. Concurrent supplies on one tanker: serialised, never negative.
 *   7. Validation, totals per period, customer-wise and tanker-wise reports, audit, month lock, read-only profiles.
 *   8. Vehicle Diesel, AdBlue, stations, payments unchanged; tanker loads stay purchases; transfers see the draws.
 *   9. Reconciliation: Opening + Opening stock + Loaded + Transfers in + Adjustments − Dispensed − Industrial − Transfers
 *      out = Closing, per tanker and for all, = the stock; each supply's litres counted exactly once.
 */
import assert from "node:assert/strict"
import { failure, loadCheckDemoData, setRole, storage, tankerRecordsOf } from "./test-browser"

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
  const { api: uiApi } = await import("./client")
  const { todayISO } = await import("@/lib/format")
  const { industrialTotals, industrialAmount, industrialProblem, industrialReport } = await import("@/domain/industrial")
  const { inQuarter } = await import("@/domain/quarters")
  const { valueTankers, tankerLedger, tankerMoves, tankerPeriod, loadsAsStationPurchases } = await import("@/domain/tanker")
  const { profileCall, PROFILE_METHODS } = await import("@/lib/server/erp/profiles")
  const { industrialInView } = await import("@/domain/industrial")
  const { rangeForPreset } = await import("@/domain/periods")
  const { cashFlow, customerProfitability, invoiceViews, monthlySeries, profitAndLoss, vehicleProfitability } = await import("@/domain/analytics")
  const { can } = await import("@/lib/permissions")
  const { profilePageAllowed } = await import("@/lib/auth/gate")
  assert.equal(todayISO(), "2026-11-10")
  loadCheckDemoData() // the demo data up to the fixed clock
  setRole("OWNER")

  const customers = (await api.customers.list()).filter((c) => c.status === "ACTIVE")
  const [c1, c2, c3] = customers
  type Alloc = { tankerId: string; litres: number }
  const sup = (customerId: string, date: string, litres: number, rate: number, allocations: Alloc[], purpose = "Generator operation", remarks = "") => ({ customerId, date, litres, rate, purpose, remarks, allocations })
  type Supply = Awaited<ReturnType<typeof api.industrialSupplies.create>>
  const same = (x: Supply) => sup(x.customerId, x.date, x.litres, x.rate, x.allocations, x.purpose, x.remarks)

  // Two company tankers with stock: JIO 500 L (Dec 2025) + 3,000 L (Oct 2026), Office 1,000 L (Oct 2026).
  const station = (await api.fuelStations.list()).find((s) => !s.isTanker && s.status === "ACTIVE")!
  const t0 = { vehicleId: null, capacityLitres: null, notes: "" }
  const jio = (await api.tankers.create({ ...t0, name: "JIO", regNo: "TN70AX9480" })).id
  const office = (await api.tankers.create({ ...t0, name: "Office", regNo: "KA53C0538" })).id
  const load = (tankerId: string, date: string, litres: number, rate: number) => api.tankerLoads.create({ tankerId, date, stationId: station.id, litres, rate, invoiceNo: "", notes: "" })
  await load(jio, "2025-12-01", 500, 85)
  await load(jio, "2026-10-01", 3000, 90)
  await load(office, "2026-10-01", 1000, 91)
  const stock = async (id: string) => valueTankers(await tankerRecordsOf()).stock.get(id)?.litres ?? 0
  const stocks = async () => [await stock(jio), await stock(office)]
  const from = (tankerId: string, litres: number): Alloc => ({ tankerId, litres })
  // Allocations are stored in tanker-id order (ids are random): compare against the same order.
  const ord = (xs: Alloc[]) => [...xs].sort((a, b) => (a.tankerId < b.tankerId ? -1 : 1))

  // An archived customer takes no new supply (run first: archiving changes the customer record itself).
  await api.customers.archive(c3.id)
  await assert.rejects(api.industrialSupplies.create(sup(c3.id, "2026-11-10", 10, 90, [from(jio, 10)])), /archived/, "no new supply for an archived customer")
  await api.customers.restore(c3.id)

  // Everything vehicle Diesel, AdBlue, stations and payments store or compute, before any industrial supply.
  const others = () => JSON.stringify(Object.keys(storage).filter((k) => !["vt:industrialSupplies", "vt:auditEvents", "vt:meta"].includes(k) && !k.startsWith("vt:ui:")).sort().map((k) => [k, storage.getItem(k)]))
  const views = async () => JSON.stringify([await api.diesel.list(), await api.adblue.list(), await api.adblueTotals.get(), await api.payments.list(), await api.fuelStations.list(), await api.tankerLoads.list(), await api.vehicles.list()])
  const stored0 = others()
  const views0 = await views()
  const purchases0 = loadsAsStationPurchases(await api.tankerLoads.list(), await api.tankers.list())
  // The Reports module's figures (profitability, P&L, cash flow, monthly series) — industrial supplies must change none.
  const reports = async () => {
    const ds = { settings: await api.settings.get(), customers: await api.customers.list(), vehicles: await api.vehicles.list(), drivers: await api.drivers.list(), trips: await api.trips.list(), diesel: await api.diesel.list(), invoices: await api.invoices.list(), payments: await api.payments.list(), assignments: await api.assignments.list(), fuelStations: await api.fuelStations.list(), tankerLoads: await api.tankerLoads.list(), tankers: await api.tankers.list() }
    const range = rangeForPreset("all")
    return JSON.stringify([vehicleProfitability(ds, range), customerProfitability(ds, range, invoiceViews(ds, todayISO())), profitAndLoss(ds, range), cashFlow(ds, range), monthlySeries(ds, ["2026-07", "2026-10", "2026-11"])])
  }
  const reports0 = await reports()

  /* ---------------------------------------------------------------- 1. one tanker, then split across two */
  const s6 = await api.industrialSupplies.create(sup(c1.id, "2025-12-20", 10, 80, [from(jio, 10)], "Borewell pump"))
  const s4 = await api.industrialSupplies.create(sup(c1.id, "2026-07-15", 40, 90, [from(jio, 40)], "Factory operations"))
  const s3 = await api.industrialSupplies.create(sup(c1.id, "2026-10-20", 100, 93, [from(jio, 100)], "Construction equipment"))
  const s1 = await api.industrialSupplies.create(sup(c1.id, "2026-11-02", 500, 94.5, [from(jio, 500)]))
  const s5 = await api.industrialSupplies.create(sup(c2.id, "2026-11-03", 999, 95, [from(jio, 999)]))
  // The owner's example: 2,000 L at ₹92 = ₹1,84,000 — JIO 1,200 L + Office 800 L.
  const s2 = await api.industrialSupplies.create(sup(c1.id, "2026-11-05", 2000, 92, [from(office, 800), from(jio, 1200)], "Industrial machinery", "  Crusher line  "))
  assert.deepEqual([s1.amount, s2.amount, s3.amount, s4.amount, s6.amount], [47250, 184000, 9300, 3600, 800], "amount = litres × that supply's rate")
  assert.deepEqual(s2.allocations, ord([from(jio, 1200), from(office, 800)]), "both tankers, kept in a stable order")
  assert.equal(s2.remarks, "Crusher line")
  assert.deepEqual(await stocks(), [3500 - 10 - 40 - 100 - 500 - 999 - 1200, 1000 - 800], "each tanker's stock lowered by its own litres: JIO 651 L, Office 200 L")
  assert.equal(industrialAmount(250.5, 96.25), 24110.63, "exact to the paisa (24,110.625 → 24,110.63)")

  /* ---------------------------------------------------------------- 2. allocations must match, active tankers only */
  const base = (allocations: Alloc[], litres = 300) => sup(c1.id, "2026-11-06", litres, 92, allocations)
  await assert.rejects(api.industrialSupplies.create(base([from(jio, 200), from(office, 99)])), /must add up to the quantity supplied \(300 L\)/, "299 L of 300 L: refused")
  await assert.rejects(api.industrialSupplies.create(base([from(jio, 301)])), /must add up/, "more than supplied: refused")
  await assert.rejects(api.industrialSupplies.create(base([])), /Choose the tanker/, "no tanker: refused")
  await assert.rejects(api.industrialSupplies.create(base([from(jio, 150), from(jio, 150)])), /each tanker once/, "the same tanker twice: refused")
  await assert.rejects(api.industrialSupplies.create(base([from(jio, 300), from(office, 0)])), /more than 0/, "a 0 L tanker row: refused")
  await assert.rejects(api.industrialSupplies.create(base([from("tnk_nope", 300)])), /Choose the tanker/, "an unknown tanker: refused")
  const pool = (await api.tankers.list()).find((t) => !t.regNo)
  if (pool) await assert.rejects(api.industrialSupplies.create(base([from(pool.id, 300)])), /Choose the tanker/, "a stock pool: refused")

  /* ---------------------------------------------------------------- 3. stock: never beyond, never negative, atomic */
  await assert.rejects(api.industrialSupplies.create(base([from(office, 300)])), /Insufficient tanker inventory in Office\. Available: 200 L on 06-11-2026/, "Office holds 200 L: 300 L refused")
  const before3 = [JSON.stringify(await api.industrialSupplies.list()), await stocks()]
  await assert.rejects(api.industrialSupplies.create(base([from(jio, 100), from(office, 250)], 350)), /Insufficient tanker inventory in Office/, "one tanker short: the whole supply is refused")
  await assert.rejects(api.industrialSupplies.create(sup(c1.id, "2026-10-15", 3200, 92, [from(jio, 3200)])), /Insufficient tanker inventory in JIO/, "back-dated: later supplies keep their litres covered")
  failure.key = "vt:auditEvents"
  failure.once = true
  await assert.rejects(api.industrialSupplies.create(base([from(jio, 50)], 50)), /simulated storage failure/, "the audit write fails…")
  assert.deepEqual([JSON.stringify(await api.industrialSupplies.list()), await stocks()], before3, "…so nothing was saved and no tanker changed (one transaction)")

  /* ---------------------------------------------------------------- 4. edit: original back first, then the new litres */
  const s3b = await api.industrialSupplies.update(s3.id, { ...same(s3), allocations: [from(office, 100)] }, "It came from the Office tanker")
  assert.deepEqual([s3b.allocations, await stocks()], [[from(office, 100)], [751, 100]], "source tanker changed: JIO gets its 100 L back, Office gives them")
  const s2b = await api.industrialSupplies.update(s2.id, { ...same(s2), allocations: [from(jio, 1100), from(office, 900)] }, "Split corrected")
  assert.deepEqual([s2b.allocations, await stocks()], [ord([from(jio, 1100), from(office, 900)]), [851, 0]], "Office: its 800 L back first, then 900 L out (900 available)")
  await assert.rejects(api.industrialSupplies.update(s1.id, { ...same(s1), allocations: [from(office, 500)] }, "Wrong tanker"), /Insufficient tanker inventory in Office\. Available: 0 L on 02-11-2026\. Later records of Office \(up to 05-11-2026\) already use the rest/, "Office's litres are already used by later supplies")
  await assert.rejects(api.industrialSupplies.update(s2.id, { ...same(s2b), allocations: [from(jio, 2000)] }, "All from JIO"), /Insufficient tanker inventory in JIO\. Available: 1,951 L/, "JIO: its own 1,100 L back, still short")
  await assert.rejects(api.industrialSupplies.update(s2.id, { ...same(s2b), litres: 2100 }, "More litres"), /must add up/, "litres changed without the tankers")
  await assert.rejects(api.industrialSupplies.update(s2.id, same(s2b), ""), /reason/, "an edit needs a reason")
  assert.deepEqual([(await api.industrialSupplies.list()).find((x) => x.id === s2.id)!.allocations, await stocks()], [s2b.allocations, [851, 0]], "refused edits change nothing")

  /* ---------------------------------------------------------------- 5. delete returns the litres once; restore once */
  const events = async () => (await api.audit.list()).length
  await assert.rejects(api.industrialSupplies.remove(s2.id, ""), /reason/, "a delete needs a reason")
  await api.industrialSupplies.remove(s2.id, "Entered twice")
  assert.deepEqual(await stocks(), [1951, 900], "deleted: JIO +1,100 L, Office +900 L")
  const e0 = await events()
  await api.industrialSupplies.remove(s2.id, "Entered twice")
  assert.deepEqual([await stocks(), await events()], [[1951, 900], e0], "a second delete finds nothing: no stock back twice, no event")
  const deleted = (await api.audit.list()).find((e) => e.action === "DELETED" && e.recordId === s2.id)!
  assert.deepEqual([deleted.before?.allocations, deleted.before?.litres, deleted.before?.rate, deleted.before?.amount, deleted.reason], [s2b.allocations, 2000, 92, 184000, "Entered twice"], "the DELETED event keeps the allocations")
  const plan = await api.audit.checkRestore(deleted.id)
  assert.ok(plan.ok && /JIO \(1,100 L\)/.test(plan.note) && /Office \(900 L\)/.test(plan.note) && / again\. /.test(plan.note), "the restore dialog says which tankers")
  await api.audit.restoreDeleted(deleted.id, "Was not a duplicate")
  assert.deepEqual(await stocks(), [851, 0], "restored: the litres out of the same tankers again")
  await assert.rejects(api.audit.restoreDeleted(deleted.id, "Again"), /Already restored/, "never restored twice")

  /* ---------------------------------------------------------------- 6. concurrent supplies on one tanker */
  const race = await Promise.allSettled([api.industrialSupplies.create(sup(c1.id, "2026-11-09", 600, 92, [from(jio, 600)])), api.industrialSupplies.create(sup(c2.id, "2026-11-09", 600, 92, [from(jio, 600)]))])
  assert.deepEqual(race.map((r) => r.status).sort(), ["fulfilled", "rejected"], "two 600 L supplies, 851 L in JIO: one saved, one refused")
  assert.match(String((race.find((r) => r.status === "rejected") as PromiseRejectedResult).reason), /Insufficient tanker inventory in JIO\. Available: 251 L/)
  assert.equal(await stock(jio), 251, "never negative")
  await api.industrialSupplies.remove((race.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<Supply>).value.id, "Concurrency check cleanup")

  /* ---------------------------------------------------------------- 7. validation, reports, audit, month lock, profiles */
  const refused: [Partial<ReturnType<typeof sup>>, RegExp][] = [
    [{ litres: -5 }, /Quantity must be more than 0/],
    [{ litres: 0 }, /Quantity must be more than 0/],
    [{ rate: -1 }, /Rate per litre must be more than/],
    [{ rate: 0 }, /Rate per litre must be more than/],
    [{ litres: 1.2345 }, /at most 3 decimals/],
    [{ rate: 94.12345 }, /at most 4 decimals/],
    [{ date: "2026-11-11" }, /future/],
    [{ date: "" }, /supply date/],
    [{ purpose: " " }, /purpose/],
    [{ purpose: "Other" }, /Describe the purpose/],
    [{ customerId: "cus_nope" }, /Customer cus_nope not found/],
  ]
  for (const [patch, why] of refused) await assert.rejects(api.industrialSupplies.create({ ...sup(c1.id, "2026-11-06", 10, 90, [from(jio, 10)]), ...patch } as never), why, JSON.stringify(patch))
  assert.equal(industrialProblem({ date: "2026-11-06", litres: 10, rate: 90, purpose: "Factory operations" }, todayISO()), null, "the same rules as the dialog")

  const all = await api.industrialSupplies.list()
  const mine = all.filter((x) => x.customerId === c1.id)
  assert.ok(!mine.some((x) => x.id === s5.id), "customer isolation: another customer's supply is never in this one's register")
  assert.deepEqual(industrialTotals(mine.filter((x) => x.date.startsWith("2026-11"))), { litres: 2500, value: 231250, avgRate: 92.5, count: 2 }, "November")
  assert.deepEqual(industrialTotals(mine.filter(inQuarter("2026", 4))), { litres: 2600, value: 240550, avgRate: 92.52, count: 3 }, "Q4 2026 (Oct–Dec)")
  assert.deepEqual(industrialTotals(mine.filter((x) => x.date.startsWith("2026"))), { litres: 2640, value: 244150, avgRate: 92.48, count: 4 }, "2026")
  assert.deepEqual(industrialTotals(mine), { litres: 2650, value: 244950, avgRate: 92.43, count: 5 }, "all time")
  const nov = industrialReport(all.filter((x) => x.date.startsWith("2026-11")))
  assert.deepEqual(nov.totals, { litres: 3499, value: 326155, avgRate: 93.21, count: 3 }, "company-wide November")
  assert.deepEqual(nov.byCustomer.sort((a, b) => a.value - b.value).map((r) => [r.customerId, r.litres, r.value]), [[c2.id, 999, 94905], [c1.id, 2500, 231250]], "customer-wise")
  assert.deepEqual(nov.byTanker.sort((a, b) => a.litres - b.litres), [{ tankerId: office, litres: 900 }, { tankerId: jio, litres: 2599 }], "tanker-wise: JIO 500 + 999 + 1,100; Office 900")
  assert.deepEqual(industrialReport([]).totals, { litres: 0, value: 0, avgRate: null, count: 0 })

  const history = await api.audit.history(s2.id)
  const updated = history.find((e) => e.action === "UPDATED")!
  assert.deepEqual([updated.module, updated.recordType, updated.actor.role, updated.reason], ["Diesel", "Industrial supply", "OWNER", "Split corrected"])
  assert.deepEqual([updated.before?.allocations, updated.after?.allocations], [ord([from(jio, 1200), from(office, 800)]), ord([from(jio, 1100), from(office, 900)])], "previous and new tanker allocations")
  assert.ok(updated.changes.some((c) => c.field === "allocations"))
  assert.ok(/JIO 1,100 L/.test(updated.label) && /Office 900 L/.test(updated.label) && / from /.test(updated.label), "the label names both tankers")

  setRole("EMPLOYEE")
  await assert.rejects(api.industrialSupplies.create(sup(c1.id, "2026-10-25", 10, 90, [from(jio, 10)])), /October 2026 is locked/, "Employee: no supply in a closed month")
  await assert.rejects(api.industrialSupplies.update(s3.id, same(s3b), "Rate fix"), /October 2026 is locked/)
  await assert.rejects(api.industrialSupplies.remove(s3.id, "Not needed"), /October 2026 is locked/)
  const e1 = await api.industrialSupplies.create(sup(c1.id, "2026-11-08", 20, 95, [from(jio, 20)]))
  assert.equal((await api.industrialSupplies.update(e1.id, sup(c1.id, "2026-11-08", 25, 95, [from(jio, 25)]), "Litres corrected")).amount, 2375, "Employee: an open month, as for Diesel")
  await api.industrialSupplies.remove(e1.id, "Test cleanup")
  setRole("DEV")
  const d1 = await api.industrialSupplies.create(sup(c1.id, "2026-10-25", 10, 90, [from(jio, 10)]))
  assert.equal((await api.audit.history(d1.id))[0].actor.role, "DEV", "Dev changes a closed month, recorded as Dev")
  await api.industrialSupplies.remove(d1.id, "Test cleanup")
  setRole("OWNER")

  for (const role of ["TATA_ADBLUE", "ADBLUE"] as const) {
    setRole(role)
    await assert.rejects(api.industrialSupplies.create(sup(c1.id, "2026-11-09", 10, 90, [from(jio, 10)])), /can't create fuel records/, `${role}: no create`)
    await assert.rejects(api.industrialSupplies.update(s1.id, same(s1), "Attempt"), /can't edit fuel records/, `${role}: no edit`)
    await assert.rejects(api.industrialSupplies.remove(s1.id, "Attempt"), /can't delete fuel records/, `${role}: no delete`)
    for (const m of ["create", "update", "remove"]) assert.equal(profileCall(role, `industrialSupplies.${m}`, async () => 1), null, `${role}: industrialSupplies.${m} is off the method list`)
    assert.ok(PROFILE_METHODS.includes("industrialSupplies.list"))
  }
  setRole("ADBLUE")
  assert.deepEqual(await uiApi.industrialSupplies.list(), await api.industrialSupplies.list(), "Adblue: every customer's supplies, read-only")
  setRole("TATA_ADBLUE")
  assert.deepEqual(await uiApi.industrialSupplies.list(), [], "Tata Adblue: its granted customers' only (the browser store has no grants)")
  setRole("OWNER")

  /* ---------------------------------------------------------------- 7b. the Reports module's Industrial Diesel tab */
  const everyone = new Set((await api.customers.list()).map((c) => c.id))
  const ids = (range: ReturnType<typeof rangeForPreset>, customersInView = everyone) => industrialInView(all, range, customersInView).map((x) => x.id).sort()
  assert.deepEqual(ids(rangeForPreset("this_month")), [s1.id, s2.id, s5.id].sort(), "This month (1–10 Nov)")
  assert.deepEqual(ids(rangeForPreset("last_month")), [s3.id], "Last month (October)")
  assert.deepEqual(ids(rangeForPreset("fy_to_date")), [s1.id, s2.id, s3.id, s4.id, s5.id].sort(), "FY to date: April 2026 on, not December 2025")
  assert.deepEqual(ids(rangeForPreset("all")), all.map((x) => x.id).sort(), "All time")
  assert.deepEqual(ids(rangeForPreset("all"), new Set([c2.id])), [s5.id], "the company scope: only the customers in view")
  assert.deepEqual(industrialReport(industrialInView(all, rangeForPreset("this_month"), everyone)).totals, nov.totals, "the tab's totals = the Diesel page's for the same period")
  for (const role of ["OWNER", "DEV", "EMPLOYEE"] as const) assert.ok(can(role, "reports"), `${role}: opens Reports (and its Industrial Diesel tab)`)
  for (const role of ["TATA_ADBLUE", "ADBLUE"] as const)
    assert.ok(!can(role, "reports") && !profilePageAllowed(role, "/reports"), `${role}: no Reports module (unchanged) — its Industrial Diesel is on the Diesel page, limited as there`)

  /* ---------------------------------------------------------------- 8. nothing else changes */
  assert.equal(others(), stored0, "vehicle Diesel, AdBlue, tankers' loads, stations, payments, customers, vehicles: stored records unchanged")
  assert.equal(await views(), views0, "…and every computed Diesel, AdBlue, station and payment view")
  assert.equal(await reports(), reports0, "Reports: vehicle and customer profitability, P&L, cash flow and the monthly series unchanged — no tanker draw counted as vehicle diesel")
  assert.deepEqual(loadsAsStationPurchases(await api.tankerLoads.list(), await api.tankers.list()), purchases0, "tanker loads stay the stations' purchases; an industrial supply is never one")
  await assert.rejects(api.tankerTransfers.create({ date: "2026-11-07", fromTankerId: office, toTankerId: jio, litres: 50, notes: "" }), /Insufficient tanker inventory in Office/, "a transfer can't take diesel already supplied")

  /* ---------------------------------------------------------------- 9. reconciliation with every kind of movement */
  await api.tankerTransfers.create({ date: "2026-11-07", fromTankerId: jio, toTankerId: office, litres: 100, notes: "" })
  await api.tankerAdjustments.create({ date: "2026-11-07", tankerId: office, litres: -10, reason: "Dip reading" })
  const vehicle = (await api.vehicles.list()).find((v) => v.status === "ACTIVE" && v.fuelType === "DIESEL" && v.assignedCustomerId)!
  const odo = Math.max(vehicle.odometerKm, ...(await api.diesel.list()).filter((e) => e.vehicleId === vehicle.id).map((e) => e.odometerKm ?? 0)) + 300
  await api.diesel.create({ date: todayISO(), vehicleId: vehicle.id, customerId: null, vendorId: "dv_tanker", tankerId: jio, litres: 50, rate: 92, odometerKm: odo, billNo: "", paymentMode: "CREDIT" })
  assert.deepEqual(await stocks(), [851 - 100 - 50, 100 - 10], "JIO 701 L, Office 90 L")
  const records = await tankerRecordsOf()
  const moves = tankerMoves(records)
  const v = valueTankers(records)
  for (const id of [jio, office, null]) {
    const rows = tankerLedger(moves, id, "2026-11")
    for (const r of rows)
      assert.equal(r.closing, Math.round((r.opening + r.openingStock + r.loaded + r.transferIn + r.adjusted - r.dispensed - r.industrial - r.transferOut) * 100) / 100, `${id ?? "all"} ${r.month}: the formula`)
    for (const [i, r] of rows.entries()) if (i) assert.equal(r.opening, rows[i - 1].closing, `${id ?? "all"} ${r.month}: opening = last month's closing`)
    const expected = id ? v.stock.get(id)!.litres : (await stock(jio)) + (await stock(office))
    assert.equal(tankerPeriod(rows).closing, expected, `${id ?? "all tankers"}: the ledger closes on the stock`)
  }
  const novJio = tankerPeriod(tankerLedger(moves, jio, "2026-11"), ["2026-11"])
  assert.deepEqual([novJio.dispensed, novJio.industrial, novJio.transferOut], [50, 500 + 999 + 1100, 100], "JIO November: vehicle fills and industrial supplies apart")
  assert.equal(tankerPeriod(tankerLedger(moves, office, "2026-11"), ["2026-10"]).industrial, 100, "Office October: the supply moved there (s3)")
  const supplied = (await api.industrialSupplies.list()).reduce((t, x) => t + x.litres, 0)
  assert.equal(tankerPeriod(tankerLedger(moves, null, "2026-11")).industrial, supplied, "every supply's litres counted exactly once in the tankers")

  /* ---------------------------------------------------------------- 10. Combined Fuel Outflow (customer page Overview) */
  const { buildDieselIndex, groupMonth, vehicleDiesel } = await import("@/domain/diesel")
  const { combinedDieselOutflow } = await import("@/domain/industrial")
  const indexNow = async () => buildDieselIndex({ customers: await api.customers.list(), vehicles: await api.vehicles.list(), drivers: await api.drivers.list(), diesel: await api.diesel.list(), trips: await api.trips.list(), assignments: await api.assignments.list() } as never)
  const supplyList = await api.industrialSupplies.list()
  const outflowOf = (ix: Awaited<ReturnType<typeof indexNow>>, customerId: string, month: string) =>
    combinedDieselOutflow(vehicleDiesel(ix, groupMonth(ix, customerId, month).entries), supplyList.filter((x) => x.customerId === customerId && x.date.startsWith(month)))
  const ix = await indexNow()
  const months = [...new Set([...ix.months, "2026-11", "2026-10", "2026-07", "2025-12"])].sort()
  let allVehicleLitres = 0, allVehicleValue = 0
  for (const m of months) {
    const g = groupMonth(ix, c1.id, m)
    const o = outflowOf(ix, c1.id, m)
    const liquid = g.entries.filter((e) => ix.vehicles.get(e.vehicleId)?.fuelType !== "EV")
    assert.equal(o.vehicle.litres, g.litres, `${m}: Vehicle Fuel (Diesel / Petrol) litres = the summary's Total Diesel Litres`)
    assert.equal(o.vehicle.value, Math.round(liquid.reduce((t, e) => t + e.amount, 0) * 100) / 100, `${m}: Vehicle Fuel Value = those fills' ₹ (petrol included, EV charging left out)`)
    const own = supplyList.filter((x) => x.customerId === c1.id && x.date.startsWith(m))
    assert.equal(o.industrial.litres, Number(own.reduce((t, x) => t + x.litres, 0).toFixed(3)), `${m}: Industrial Diesel Litres`)
    assert.equal(o.combined.litres, Number((o.vehicle.litres + o.industrial.litres).toFixed(3)), `${m}: Combined (L) = vehicle + industrial`)
    assert.equal(o.combined.value, Math.round((o.vehicle.value + o.industrial.value) * 100) / 100, `${m}: Combined (₹) = vehicle + industrial`)
    allVehicleLitres += o.vehicle.litres
    allVehicleValue += o.vehicle.value
  }
  assert.deepEqual([outflowOf(ix, c1.id, "2026-11").industrial.litres, outflowOf(ix, c1.id, "2026-10").industrial.litres, outflowOf(ix, c1.id, "2026-07").industrial.litres], [2500, 100, 40], "each month: only its own supplies (Nov s1 + s2, Oct s3, Jul s4)")
  assert.equal(outflowOf(ix, c1.id, "2026-11").industrial.entries, 2, "…and never another customer's (s5 is c2's)")
  const everyFill = vehicleDiesel(ix, [...ix.fills.entries()].filter(([k]) => k.startsWith(`${c1.id}|`)).flatMap(([, v]) => v))
  assert.ok(everyFill.entries > 0 && everyFill.litres > 0, "the customer has vehicle fills to combine")
  assert.equal(Math.round(allVehicleLitres * 100) / 100, everyFill.litres, "Σ months = every vehicle fill once (no double counting)")
  assert.equal(Math.round(allVehicleValue * 100) / 100, everyFill.value)
  // AdBlue is never part of it: a new AdBlue entry for one of this customer's vehicles changes nothing.
  const before = JSON.stringify(outflowOf(ix, c1.id, "2026-11"))
  const abVehicle = (await api.vehicles.list()).find((v) => v.status === "ACTIVE" && v.assignedCustomerId === c1.id)
  assert.ok(abVehicle, "a vehicle of this customer for the AdBlue step")
  if (abVehicle) {
    await api.adbluePurchases.create({ date: todayISO(), vendorName: "Outflow Check", product: "AdBlue", buckets: 1, litresPerBucket: 20, pricePerBucket: 900, invoiceNo: "", notes: "" })
    await api.adblue.create({ vehicleId: abVehicle.id, customerId: c1.id, date: todayISO(), closingKm: 9_999_000, quantityLitres: 5, invoiceNo: "", notes: "", source: "STOCK" })
    assert.equal(JSON.stringify(outflowOf(await indexNow(), c1.id, "2026-11")), before, "an AdBlue entry: Combined Fuel Outflow unchanged")
  }
  assert.deepEqual(combinedDieselOutflow({ litres: 0, value: 0, entries: 0 }, []).combined, { litres: 0, value: 0, avgRate: null }, "no data: zeros, no rate")

  /* ---------------------------------------------------------------- 11. Diesel landing customer cards: vehicle fuel + industrial */
  const { customerCards } = await import("@/domain/diesel")
  const { withCustomerExpenditure } = await import("@/domain/expenditure")
  // Industrial supplies only here (no AdBlue): check:fuel-wise covers the cards with AdBlue too.
  const withIndustrialSpend = <C extends Parameters<typeof withCustomerExpenditure>[0][number]>(cards: C[], supplies: Parameters<typeof withCustomerExpenditure>[1]["supplies"], period: Parameters<typeof withCustomerExpenditure>[2]) => withCustomerExpenditure(cards, { supplies, adblue: [] }, period)
  const r2 = (n: number) => Math.round(n * 100) / 100
  const own = (id: string | null, pred: (d: string) => boolean) => r2(supplyList.filter((x) => x.customerId === id && pred(x.date)).reduce((t, x) => t + x.amount, 0))
  for (const [month, today] of [["2026-11", "2026-11-10"], ["2026-10", "2026-11-10"], ["2026-07", "2026-11-10"]] as const) {
    const base = customerCards(ix, month, today)
    const cards = withIndustrialSpend(base.cards, supplyList, base)
    for (const [i, c] of cards.entries()) {
      const v = base.cards[i]
      assert.equal(c.vehicleSpend, v.spend, `${month} ${c.group.shortName}: the vehicle part is the card's existing figure, unchanged`)
      assert.equal(c.spend, r2(v.spend + own(c.group.id, (d) => d.startsWith(month))), `${month} ${c.group.shortName}: vehicle + its own supplies of the month`)
      // The comparison uses the same days for both sources: previous month, capped at today's day while in progress.
      assert.equal(c.compareSpend, r2(v.compareSpend + own(c.group.id, (d) => d.startsWith(base.prev) && (base.day === undefined || Number(d.slice(8, 10)) <= base.day))), `${month} ${c.group.shortName}: comparison, both sources`)
      assert.equal(c.prevMonthSpend, r2(v.prevMonthSpend + own(c.group.id, (d) => d.startsWith(base.prev))), `${month} ${c.group.shortName}: previous full month, both sources`)
      assert.equal(c.changePct, c.compareSpend > 0 ? ((c.spend - c.compareSpend) / c.compareSpend) * 100 : null)
    }
    // Reconciliation: Σ cards = Σ vehicle fills of the month (the Diesel Spend KPI) + Σ that month's supplies, each once.
    assert.equal(r2(cards.reduce((t, c) => t + c.spend, 0)), r2(base.total + supplyList.filter((x) => x.date.startsWith(month)).reduce((t, x) => t + x.amount, 0)), `${month}: Σ cards = Diesel Spend + industrial supplies`)
  }
  const nov11 = withIndustrialSpend(customerCards(ix, "2026-11", "2026-11-10").cards, supplyList, { month: "2026-11", prev: "2026-10", day: 10 })
  const card = (id: string) => nov11.find((c) => c.group.id === id)!
  assert.equal(card(c1.id).industrialSpend, r2(s1.amount + s2.amount), "c1 November: s1 + s2 (s2 split across two tankers, counted once by its amount)")
  assert.equal(card(c2.id).industrialSpend, s5.amount, "c2: only its own supply")
  assert.equal(r2(card(c1.id).compareSpend - customerCards(ix, "2026-11", "2026-11-10").cards.find((c) => c.group.id === c1.id)!.compareSpend), 0, "s3 (20 Oct) is after day 10: not in the 1–10 Oct comparison…")
  assert.equal(r2(card(c1.id).prevMonthSpend - customerCards(ix, "2026-11", "2026-11-10").cards.find((c) => c.group.id === c1.id)!.prevMonthSpend), s3.amount, "…but in October's full figure")
  // The four kinds of customer, the Unallocated card, other months and other customers.
  const g = (id: string | null, spend: number, compareSpend = 0, prevMonthSpend = compareSpend) => ({ group: { id }, spend, compareSpend, prevMonthSpend, changePct: null })
  const x = (customerId: string, date: string, amount: number) => ({ customerId, date, amount, allocations: [{ tankerId: "t1", litres: 1 }, { tankerId: "t2", litres: 1 }] })
  const out = withIndustrialSpend(
    [g("veh", 1000, 500), g("ind", 0), g("both", 300.1, 100), g("zero", 0), g(null, 50)],
    [x("ind", "2026-11-03", 250.55), x("both", "2026-11-04", 0.2), x("both", "2026-10-05", 100), x("both", "2026-10-25", 7), x("veh", "2026-09-01", 9999), x("nobody", "2026-11-01", 1)],
    { month: "2026-11", prev: "2026-10", day: 10 }
  )
  assert.deepEqual(out.map((c) => [c.group.id, c.spend, c.industrialSpend, c.compareSpend, c.prevMonthSpend, c.changePct]), [
    ["veh", 1000, 0, 500, 500, 100],
    ["ind", 250.55, 250.55, 0, 0, null],
    ["both", 300.3, 0.2, 200, 207, ((300.3 - 200) / 200) * 100],
    ["zero", 0, 0, 0, 0, null],
    [null, 50, 0, 0, 0, null],
  ], "vehicle only, industrial only, both (exact paise; 25 Oct outside the 1–10 comparison), zero, Unallocated; other months and customers ignored")
  // Restricted access: Tata Adblue's list holds only its granted customers' supplies (server shape, pinned in check:erp-db 12d).
  const scoped = (await profileCall("TATA_ADBLUE", "industrialSupplies.list", async () => supplyList, new Set([c2.id]))!()) as typeof supplyList
  assert.deepEqual(scoped.map((s) => s.id), [s5.id], "Tata Adblue granted c2 only: c2's supply only")
  const tata = withIndustrialSpend(customerCards(ix, "2026-11", "2026-11-10").cards, scoped, { month: "2026-11", prev: "2026-10", day: 10 })
  assert.equal(tata.find((c) => c.group.id === c1.id)!.industrialSpend, 0, "…so no other customer's supply reaches any card total")

  console.log("industrial diesel supply: tanker allocations (one and split), exact matching, stock never negative, atomic rollback, edit / delete / restore returning litres once, concurrency, reconciliation, reports, audit, month lock, read-only profiles, vehicle Diesel untouched: all checks passed")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
