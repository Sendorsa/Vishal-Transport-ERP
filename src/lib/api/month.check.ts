/**
 * Month and year transitions in India time: npm run check:month. Real API on in-memory demo data, a fake clock moved
 * across 31 Oct → 1 Nov 2026 and 31 Dec 2026 → 1 Jan 2027 (IST) — with this process in New York time, so the device's
 * time zone can't decide the business month. Also: the month a page opens on, the month lock for the three roles,
 * carry-forward across the year end, and fuel station payments for old months (payment date vs paid against).
 */
import assert from "node:assert/strict"
import { checkTanker, setRole } from "./test-browser"

process.env.TZ = "America/New_York" // Node re-reads TZ on change: device time 10½ hours behind India

const RealDate = Date
let NOW = 0
class FakeDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length) super(...(args as [string]))
    else super(NOW)
  }
  static now() {
    return NOW
  }
}
globalThis.Date = FakeDate as DateConstructor
/** Set the clock to an India date-time, e.g. "2026-10-31T23:59:30". */
const at = (ist: string) => (NOW = new RealDate(`${ist}+05:30`).getTime())
at("2026-10-15T10:00:00")

async function main() {
  const { api } = await import("./index")
  const { todayISO, msUntilIndiaMidnight, round2 } = await import("@/lib/format")
  const { dieselMonths, pickMonth } = await import("@/domain/diesel")
  const { canEditMonth, monthLockInfo } = await import("@/domain/month-lock")
  const { ledgerFor, openingOf, stationLedger } = await import("@/domain/station-ledger")
  const { loadsAsStationPurchases, tankerLedger, tankerMoves, tankerPeriod } = await import("@/domain/tanker")
  const { inventoryLedger, stockDraws, stockFor } = await import("@/domain/adblue-inventory")
  const { tankerRecordsOf } = await import("./test-browser")

  /* ---------------------------------------------------------------- 1. India time, whatever the device's time zone */
  assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, "America/New_York")
  at("2026-10-31T23:59:30")
  assert.equal(todayISO(), "2026-10-31")
  assert.equal(msUntilIndiaMidnight(), 30_000)
  at("2026-11-01T00:00:30") // New York is still 31 Oct, 14:30
  assert.equal(new Date().getDate(), 31) // the device's own date…
  assert.equal(todayISO(), "2026-11-01") // …never decides the business date
  at("2026-12-31T23:59:59")
  assert.equal(todayISO(), "2026-12-31")
  at("2027-01-01T00:00:00")
  assert.equal(todayISO(), "2027-01-01")
  assert.equal(msUntilIndiaMidnight(), 86_400_000)

  /* ---------------------------------------------------------------- 2. The month a page opens on (pickMonth) */
  const withData = ["2026-10", "2026-09", "2026-08"]
  const months = (today: string) => dieselMonths({ months: withData } as never, today)
  assert.deepEqual(months("2026-10-31"), ["2026-10", "2026-09", "2026-08"])
  assert.deepEqual(months("2026-11-01"), ["2026-11", "2026-10", "2026-09", "2026-08"]) // November appears by itself
  assert.equal(pickMonth(months("2026-10-31"), "2026-10@2026-10", "2026-10"), "2026-10")
  assert.equal(pickMonth(months("2026-11-01"), "2026-10@2026-10", "2026-11"), "2026-11") // October picked last month → November
  assert.equal(pickMonth(months("2026-11-01"), "2026-10", "2026-11"), "2026-11") // the old plain "yyyy-MM" value → latest
  assert.equal(pickMonth(months("2026-11-15"), "2026-09@2026-11", "2026-11"), "2026-09") // picked this month: kept
  assert.equal(pickMonth(months("2026-11-15"), "", "2026-11"), "2026-11")
  const jan = dieselMonths({ months: ["2026-12", ...withData] } as never, "2027-01-01")
  assert.equal(jan[0], "2027-01") // January 2027 appears by itself, newest first
  assert.ok(jan.includes("2026-12") && jan.includes("2026-08")) // 2026 stays reachable
  assert.equal(pickMonth(jan, "2026-12@2026-12", "2027-01"), "2027-01")
  // Year lists (usePeriod, Yearly / Quarterly Master) = the current India year + the years with data → 2027 appears.
  assert.deepEqual([...new Set([todayISO().slice(0, 4), ...jan.map((m) => m.slice(0, 4))])].sort().reverse(), ["2027", "2026"])
  assert.ok(!dieselMonths({ months: ["2027-02", ...withData] } as never, "2027-01-15").includes("2027-02")) // never a future month
  // Reports / Invoices / Customers presets count from India's today too (00:00:30 IST on 1 Jan = 31 Dec in New York).
  const { rangeForPreset } = await import("@/domain/periods")
  at("2027-01-01T00:00:30")
  assert.deepEqual(rangeForPreset("this_month"), { from: "2027-01-01", to: "2027-01-01" })
  assert.deepEqual(rangeForPreset("last_month"), { from: "2026-12-01", to: "2026-12-31" })

  /* ---------------------------------------------------------------- 3. Month lock across both boundaries, three roles */
  at("2026-10-31T23:59:30")
  setRole("OWNER")
  const vehicles = await api.vehicles.list()
  const v = vehicles.find((x) => x.status === "ACTIVE" && x.fuelType === "DIESEL" && x.assignedCustomerId)!
  let odo = Math.max(v.odometerKm, ...(await api.diesel.list()).filter((e) => e.vehicleId === v.id).map((e) => e.odometerKm ?? 0))
  const fill = (date: string, litres = 40) => ({ date, vehicleId: v.id, customerId: v.assignedCustomerId, vendorId: "dv_lakshmitha", litres, rate: 95, odometerKm: (odo += 100), billNo: "", paymentMode: "CREDIT" as const })
  const lock = (month: string) => monthLockInfo(month, todayISO(), []).state
  setRole("EMPLOYEE")
  const octEntry = await api.diesel.create(fill("2026-10-31")) // 31 Oct 23:59:30: October open
  assert.equal(lock("2026-10"), "OPEN")
  at("2026-11-01T00:00:30")
  assert.deepEqual([lock("2026-10"), lock("2026-11")], ["LOCKED", "OPEN"])
  const edit = (e: typeof octEntry) => ({ date: e.date, vendorId: e.vendorId, litres: e.litres + 1, rate: e.rate, odometerKm: e.odometerKm, billNo: e.billNo, paymentMode: e.paymentMode })
  setRole("EMPLOYEE")
  await assert.rejects(api.diesel.update(octEntry.id, edit(octEntry)), /October 2026 is locked/)
  await assert.rejects(api.diesel.create(fill("2026-10-30")), /October 2026 is locked/) // back-dated
  await api.diesel.create(fill("2026-11-01")) // November is open
  setRole("DEV")
  assert.ok(canEditMonth("DEV", "2026-10", todayISO(), await api.monthLocks.list()), "Dev keeps the Owner's access to locked months")
  setRole("OWNER")
  await api.diesel.update(octEntry.id, edit(octEntry), "Owner correction") // the Owner keeps access to locked months
  assert.deepEqual((await api.audit.history(octEntry.id)).map((e) => [e.action, e.actor.role]), [["CREATED", "EMPLOYEE"], ["UPDATED", "OWNER"]])

  /* ---------------------------------------------------------------- 4. Fuel station payments for old months */
  const station = "dv_lakshmitha"
  const paymentsOf = async () => (await api.payments.list()).filter((p) => p.vendorId === station && p.categoryCode === "DIESEL_SETTLEMENT")
  const ledger = async () => {
    const purchases = [...(await api.diesel.list()), ...loadsAsStationPurchases(await api.tankerLoads.list())]
    const s = (await api.fuelStations.list()).find((x) => x.id === station)!
    return stationLedger(station, purchases, await api.payments.list(), todayISO().slice(0, 7), openingOf(s))
  }
  const paidIn = async (m: string) => ledgerFor(await ledger(), [m]).paid
  const octPaid0 = await paidIn("2026-10")
  const paidAll0 = round2((await paymentsOf()).reduce((t, p) => t + p.amount, 0))
  setRole("EMPLOYEE")
  await assert.rejects(api.fuelStationPayments.create({ stationId: station, paymentDate: "2026-10-31", amount: 1, paymentMode: "NEFT", notes: "", companyCode: "VT", forMonth: "2026-10" }), /is locked/) // Employees follow the lock
  setRole("DEV")
  at("2026-11-15T11:00:00")
  const novPay = await api.fuelStationPayments.create({ stationId: station, paymentDate: "2026-11-15", amount: 100000, paymentMode: "NEFT", notes: "", companyCode: "VT", forMonth: "2026-10" })
  at("2026-12-15T11:00:00")
  const decPay = await api.fuelStationPayments.create({ stationId: station, paymentDate: "2026-12-15", amount: 200000, paymentMode: "NEFT", notes: "", companyCode: "VT", forMonth: "2026-10" })
  await assert.rejects(api.fuelStationPayments.create({ stationId: station, paymentDate: "2026-12-15", amount: 1, paymentMode: "NEFT", notes: "", companyCode: "VT", forMonth: "2027-01" }), /after its payment date/)
  await assert.rejects(api.fuelStationPayments.create({ stationId: station, paymentDate: "2026-12-16", amount: 1, paymentMode: "NEFT", notes: "", companyCode: "VT", forMonth: "2026-10" }), /future/)
  await assert.rejects(api.fuelStationPayments.create({ stationId: station, paymentDate: "2026-12-15", amount: 1, paymentMode: "NEFT", notes: "", companyCode: "VT", forMonth: "Oct" }), /month this payment is against/)
  // Back-dating into a locked month: only the Owner and Dev record payments at all, and both may (Owner-level authority).
  at("2027-01-10T11:00:00")
  const janPay = await api.fuelStationPayments.create({ stationId: station, paymentDate: "2027-01-10", amount: 50000, paymentMode: "UPI", notes: "", companyCode: "VT", forMonth: "2026-09" })
  setRole("OWNER")
  const listed = (await api.fuelStationPayments.list()).filter((p) => [novPay.id, decPay.id, janPay.id].includes(p.id))
  assert.deepEqual(
    listed.map((p) => [p.paymentDate, p.forMonth]).sort(),
    [["2026-11-15", "2026-10"], ["2026-12-15", "2026-10"], ["2027-01-10", "2026-09"]]
  ) // payment date and paid-against month recorded separately
  // The ledger counts each payment once, in its payment month — never in the month it was paid against.
  assert.equal(await paidIn("2026-10"), octPaid0)
  assert.equal(await paidIn("2026-11"), 100000)
  assert.equal(await paidIn("2026-12"), 200000)
  assert.equal(await paidIn("2027-01"), 50000)
  assert.equal(round2((await paymentsOf()).reduce((t, p) => t + p.amount, 0)), round2(paidAll0 + 350000))
  const rows = await ledger()
  for (let i = 1; i < rows.length; i++) assert.equal(rows[i].opening, rows[i - 1].closing) // closing → next opening, across 2027
  for (const r of rows) assert.equal(round2(r.opening + r.purchased - r.paid), r.closing)
  // The Owner may still back-date a payment into a locked month (Monthly Sheet Lock): no grace period any more.
  const ownerLate = await api.fuelStationPayments.create({ stationId: station, paymentDate: "2026-10-20", amount: 10, paymentMode: "CASH", notes: "", companyCode: "VT", forMonth: "2026-10" })
  assert.equal(await paidIn("2026-10"), round2(octPaid0 + 10))
  await api.fuelStationPayments.remove(ownerLate.id, "Check: test record")

  /* ---------------------------------------------------------------- 5. December → January: lock and carry-forward */
  at("2026-12-20T10:00:00")
  const tk = await checkTanker()
  await api.tankerLoads.create({ tankerId: tk, date: "2026-12-20", stationId: station, invoiceNo: "", litres: 1000, rate: 92, notes: "" })
  await api.adbluePurchases.create({ date: "2026-12-20", vendorName: "Check vendor", product: "AdBlue", buckets: 10, litresPerBucket: 20, pricePerBucket: 900, invoiceNo: "", notes: "" })
  await api.adblue.create({ date: "2026-12-20", vehicleId: v.id, customerId: v.assignedCustomerId, closingKm: odo + 10, quantityLitres: 15, invoiceNo: "", notes: "" })
  at("2026-12-31T23:59:30")
  setRole("EMPLOYEE")
  const decEntry = await api.diesel.create(fill("2026-12-31"))
  assert.equal(lock("2026-12"), "OPEN")
  at("2027-01-01T00:00:30")
  assert.deepEqual([lock("2026-12"), lock("2027-01")], ["LOCKED", "OPEN"])
  setRole("EMPLOYEE")
  await assert.rejects(api.diesel.update(decEntry.id, edit(decEntry)), /December 2026 is locked/)
  setRole("EMPLOYEE")
  const janFill = await api.diesel.create(fill("2027-01-01"))
  setRole("OWNER")
  await api.diesel.update(decEntry.id, edit(decEntry), "Owner correction")
  // Nothing is copied into January: only the one January fill exists.
  assert.deepEqual((await api.diesel.list()).filter((e) => e.date.startsWith("2027-01")).map((e) => e.id), [janFill.id])
  // Carry-forward across the year end: station ledgers, the tanker, AdBlue.
  const purchases = [...(await api.diesel.list()), ...loadsAsStationPurchases(await api.tankerLoads.list())]
  for (const s of await api.fuelStations.list()) {
    const r = stationLedger(s.id, purchases, await api.payments.list(), "2027-01", openingOf(s))
    if (!r.length) continue
    assert.equal(ledgerFor(r, ["2027-01"]).opening, ledgerFor(r, ["2026-12"]).closing, `${s.name}: January opens at December's closing`)
  }
  const recs = await tankerRecordsOf()
  const tl = tankerLedger(tankerMoves(recs), tk, "2027-01")
  assert.deepEqual([tankerPeriod(tl, ["2026-12"]).closing, tankerPeriod(tl, ["2027-01"]).opening, tankerPeriod(tl, ["2027-01"]).carriedFrom], [1000, 1000, "2026-12"])
  const ab = inventoryLedger(await api.adbluePurchases.list(), stockDraws(await api.adblue.list()), "2027-01")
  const abDec = stockFor(ab, ["2026-12"])
  assert.deepEqual([stockFor(ab, ["2027-01"]).opening, stockFor(ab, ["2027-01"]).carriedFrom], [abDec.closing, "2026-12"])
  assert.equal(stockFor(ab, ["2027-01"]).purchased, 0) // carry-forward is never a purchase

  /* ---------------------------------------------------------------- 6. The three roles: Audit Log and restore */
  setRole("EMPLOYEE")
  assert.ok((await api.audit.list()).length > 0) // the Employee reads the log (owner, 5 Nov 2026), read-only…
  await assert.rejects(api.audit.markReviewed([]), /Only the Owner or Dev/) // …never reviews
  setRole("DEV")
  assert.ok((await api.audit.list()).length > 0) // Dev views the log…
  const devDel = (await api.audit.list()).find((e) => e.action === "DELETED" && e.recordId === ownerLate.id)!
  setRole("EMPLOYEE")
  await assert.rejects(api.audit.restoreDeleted(devDel.id, "Employee attempt"), /Only the Owner or Dev/)
  setRole("DEV")
  await api.audit.restoreDeleted(devDel.id, "Dev restores") // …and restores (Owner-level authority)
  assert.ok(await api.payments.get(ownerLate.id))

  console.log("month transitions (India time, Oct → Nov, Dec → Jan), old-month payments and roles: all checks passed")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
