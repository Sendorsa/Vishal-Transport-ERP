/**
 * Runnable check for the audit trail:  npm run check:audit
 * Runs the real API (src/lib/api/index.ts) against an in-memory localStorage seeded with demo data —
 * no browser, no user data. Fails loudly if a change can land without its audit event (or vice versa),
 * if history is overwritten, if a non-Owner can read the log, or if auditing changes any total.
 */
import assert from "node:assert/strict"

import { checkTanker, failure, setRole, tankerRecordsOf } from "./test-browser"

async function main() {
  const { api } = await import("./index")
  const { todayISO, round2 } = await import("@/lib/format")
  const { stationLedger, ledgerFor } = await import("@/domain/station-ledger")
  const { valueTankers } = await import("@/domain/tanker")
  const { matchesAudit, formatAuditTime, newestFirst, summarizeChanges } = await import("@/domain/audit")

  const today = todayISO()
  const month = today.slice(0, 7)
  const [y, m] = month.split("-").map(Number)
  const ym = (yy: number, mm: number) => `${mm < 1 ? yy - 1 : yy}-${String(((mm + 11) % 12) + 1).padStart(2, "0")}`
  const lastMonth = ym(y, m - 1)
  const twoMonthsAgo = ym(y, m - 2)

  setRole("OWNER")
  const TK = await checkTanker()
  const log = () => api.audit.list()
  const count = async () => (await log()).length

  // 0. The checks start on demo data (test-browser.ts) — recorded as a SYSTEM event, not a user one.
  const first = await log()
  assert.equal(first.length, 1)
  assert.deepEqual([first[0].action, first[0].actor.kind, first[0].actor.role], ["DATA_RESET", "SYSTEM", null])

  // 1. Create → CREATED, attributed to the session role; no invented user name.
  const station = await api.fuelStations.create({ name: "Audit Check Fuels", location: "Hosur" })
  let ev = (await log())[0]
  assert.deepEqual([ev.action, ev.module, ev.recordType, ev.recordId, ev.label], ["CREATED", "Fuel Stations", "Fuel station", station.id, "Audit Check Fuels"])
  assert.deepEqual(ev.actor, { kind: "SESSION", userId: null, name: null, role: "OWNER" })
  assert.equal(ev.before, null)
  assert.equal((ev.after as { name: string }).name, "Audit Check Fuels")
  // Creating a name that already exists returns that station and records nothing.
  const n0 = await count()
  await api.fuelStations.create({ name: "audit check fuels" })
  assert.equal(await count(), n0)

  // 2. Edit (spec example): 100 L @ ₹95 → 110 L, odometer 45,000 → 45,100, by an Employee, with a reason.
  const vehicles = await api.vehicles.list()
  const vehicle = vehicles.find((v) => v.status === "ACTIVE" && v.fuelType === "DIESEL" && v.assignedCustomerId)!
  const fills = (await api.diesel.list()).filter((e) => e.vehicleId === vehicle.id)
  const odo = Math.max(vehicle.odometerKm, ...fills.map((e) => e.odometerKm ?? 0)) + 500
  setRole("EMPLOYEE")
  const entry = await api.diesel.create({ date: today, vehicleId: vehicle.id, customerId: vehicle.assignedCustomerId, vendorId: "dv_raghuveer", litres: 100, rate: 95, odometerKm: odo, billNo: "AUD-1", paymentMode: "CREDIT" })
  assert.equal(entry.amount, 9500)
  const stationPurchased = async () => ledgerFor(stationLedger("dv_raghuveer", await api.diesel.list(), await api.payments.list()), [month]).purchased
  const purchasedBefore = await stationPurchased()
  const input = { date: today, vendorId: "dv_raghuveer", litres: 110, rate: 95, odometerKm: odo + 100, billNo: "AUD-1", paymentMode: "CREDIT" as const }
  await api.diesel.update(entry.id, input, "Incorrect litres entered")
  setRole("OWNER")
  ev = (await log())[0]
  assert.deepEqual([ev.action, ev.module, ev.recordId, ev.reason, ev.actor.role, ev.recordDate], ["UPDATED", "Diesel", entry.id, "Incorrect litres entered", "EMPLOYEE", today])
  const byField = (cs: typeof ev.changes) => cs.map((c) => [c.field, c.before, c.after]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))
  assert.deepEqual(byField(ev.changes), [["amount", 9500, 10450], ["litres", 100, 110], ["odometerKm", odo, odo + 100]]) // rate unchanged → not listed
  assert.deepEqual([(ev.before as { rate: number }).rate, (ev.after as { rate: number }).rate], [95, 95]) // full snapshots keep it
  assert.equal(summarizeChanges([ev.changes.find((c) => c.field === "litres")!, ev.changes.find((c) => c.field === "amount")!, ev.changes.find((c) => c.field === "odometerKm")!], undefined, 2), "Litres: 100 L → 110 L · Amount: ₹9,500.00 → ₹10,450.00 · +1 more")

  // 13. Totals: the edit counts once — station purchases move by exactly ₹950, nothing is double-counted.
  assert.equal(round2((await stationPurchased()) - purchasedBefore), 950)
  assert.equal((await api.diesel.list()).filter((e) => e.id === entry.id).length, 1)

  // 3. Edited three more times → every version stays; the first "before" is still 100 L.
  for (const litres of [111, 112, 113]) await api.diesel.update(entry.id, { ...input, litres }, `fix ${litres}`)
  const hist = await api.audit.history(entry.id)
  assert.deepEqual(hist.map((e) => e.action), ["CREATED", "UPDATED", "UPDATED", "UPDATED", "UPDATED"])
  assert.deepEqual(hist.slice(1).map((e) => [(e.before as { litres: number }).litres, (e.after as { litres: number }).litres]), [[100, 110], [110, 111], [111, 112], [112, 113]])
  // Saving without a change records nothing.
  const n1 = await count()
  await api.diesel.update(entry.id, { ...input, litres: 113 })
  assert.equal(await count(), n1)

  // 4. Edited badge source: edited records only.
  const edited = new Set(await api.audit.editedIds())
  assert.ok(edited.has(entry.id))
  assert.ok(!edited.has(station.id))

  // 7 / 8. Central log: Owner and Dev only (Dev in check:roles), refused in the API for every other role. History respects module access.
  for (const r of ["EMPLOYEE", "ACCOUNTANT", "OPS_MANAGER"] as const) {
    setRole(r)
    await assert.rejects(api.audit.list(), /Only the Owner and Dev can view the audit log/)
  }
  setRole("EMPLOYEE")
  assert.equal((await api.audit.history(entry.id)).length, 5) // diesel: employees can see diesel records
  setRole("OWNER")
  // Append-only: the audit API has no way to change or delete an event.
  assert.deepEqual(Object.keys(api.audit).sort(), ["checkRestore", "editedIds", "history", "list", "markReviewed", "restoreDeleted", "unreviewedDeletions"])

  // 9. Archive and restore.
  await api.vehicles.archive(vehicle.id)
  await api.vehicles.restore(vehicle.id)
  const vh = await api.audit.history(vehicle.id)
  assert.deepEqual(vh.map((e) => e.action), ["ARCHIVED", "RESTORED"])
  assert.deepEqual(vh[0].changes.map((c) => [c.field, c.before, c.after]), [["status", "ACTIVE", "ARCHIVED"]])

  // Vehicle transfer.
  const customers = (await api.customers.list()).filter((c) => c.status === "ACTIVE" && c.id !== vehicle.assignedCustomerId)
  await api.vehicles.transfer(vehicle.id, customers[0].id, today, "Moved to new contract")
  ev = (await log())[0]
  assert.deepEqual([ev.action, ev.recordType, ev.reason], ["TRANSFERRED", "Vehicle assignment", "Moved to new contract"])
  assert.deepEqual(ev.changes.map((c) => c.field).sort(), ["assignedCustomerId", "effectiveDate"])

  // 10. Delete keeps history: tanker load added then deleted; inventory returns to where it was.
  const stock = async () => valueTankers(await tankerRecordsOf()).stock.get(TK)?.litres ?? 0
  const stock0 = await stock()
  const load = await api.tankerLoads.create({ tankerId: TK, date: today, stationId: "dv_lakshmitha", invoiceNo: "AUD-L", litres: 500, rate: 95, notes: "" })
  assert.equal(await stock(), stock0 + 500)
  await api.tankerLoads.remove(load.id, "Entered twice")
  assert.equal(await stock(), stock0)
  const lh = await api.audit.history(load.id)
  assert.deepEqual(lh.map((e) => e.action), ["CREATED", "DELETED"])
  assert.deepEqual([(lh[1].before as { litres: number }).litres, lh[1].after, lh[1].reason], [500, null, "Entered twice"])
  assert.equal((await log()).find((e) => e.recordId === load.id && e.action === "DELETED")!.recordExists, false)

  // 11. Payments: recorded, edited, deleted — each with before / after.
  const pay = await api.fuelStationPayments.create({ stationId: "dv_raghuveer", paymentDate: today, amount: 10000, paymentMode: "NEFT", notes: "", companyCode: "VT" })
  await api.fuelStationPayments.update(pay.id, { paymentDate: today, amount: 12000, paymentMode: "NEFT", notes: "" }, "Wrong payment amount")
  await api.fuelStationPayments.remove(pay.id, "Duplicate voucher")
  const ph = await api.audit.history(pay.id)
  assert.deepEqual(ph.map((e) => [e.action, e.module, e.recordType]), [["PAYMENT_RECORDED", "Fuel Stations", "Fuel station payment"], ["UPDATED", "Fuel Stations", "Fuel station payment"], ["DELETED", "Fuel Stations", "Fuel station payment"]])
  assert.deepEqual(ph[1].changes.map((c) => [c.field, c.before, c.after]), [["amount", 10000, 12000]])
  assert.deepEqual([ph[2].reason, (ph[2].before as { amount: number }).amount], ["Duplicate voucher", 12000])

  // 12 / 14. Failed operations leave no event and no change.
  //   a) Month lock: an Employee can't edit last month's entry (auto-locked).
  const old = (await api.diesel.list()).find((e) => e.date.startsWith(lastMonth) && e.vendorId !== "dv_tanker")!
  setRole("EMPLOYEE")
  const n2 = (await api.audit.history(old.id)).length
  await assert.rejects(api.diesel.update(old.id, { date: old.date, vendorId: old.vendorId, litres: old.litres + 1, rate: old.rate, odometerKm: old.odometerKm, billNo: old.billNo, paymentMode: old.paymentMode }), /is locked/)
  assert.equal((await api.audit.history(old.id)).length, n2)
  assert.equal((await api.diesel.get(old.id))!.litres, old.litres)
  //   b) The Owner may edit a locked month (Monthly Sheet Lock) — and it is recorded as the Owner.
  setRole("OWNER")
  await api.diesel.update(old.id, { date: old.date, vendorId: old.vendorId, litres: old.litres + 1, rate: old.rate, odometerKm: old.odometerKm, billNo: old.billNo, paymentMode: old.paymentMode }, "Odometer correction")
  assert.deepEqual([(await log())[0].recordId, (await log())[0].actor.role], [old.id, "OWNER"])
  //   c) A refused station payment (Employee: no payment permission) records nothing.
  const n3 = await count()
  setRole("EMPLOYEE")
  await assert.rejects(api.fuelStationPayments.create({ stationId: "dv_raghuveer", paymentDate: `${twoMonthsAgo}-10`, amount: 1, paymentMode: "NEFT", notes: "", companyCode: "VT" }), /can't/)
  setRole("OWNER")
  assert.equal(await count(), n3)
  //   d) If the audit write itself fails, the record change is rolled back too —
  //      once (the restore succeeds) and persistently (even restoring the audit key fails).
  for (const once of [true, false]) {
    failure.key = "vt:auditEvents"
    failure.once = once
    const error = console.error
    console.error = () => {} // the persistent case logs the failed restore
    await assert.rejects(api.diesel.update(entry.id, { ...input, litres: 150 }), /simulated storage failure/)
    console.error = error
    failure.key = null
    assert.equal((await api.diesel.get(entry.id))!.litres, 113)
    assert.equal(await count(), n3)
  }
  //   e) Concurrent writes are serialised: both land, both are recorded.
  const [c1, c2] = (await api.customers.list()).slice(0, 2)
  await Promise.all([api.customers.update(c1.id, { notes: "concurrent A" }), api.customers.update(c2.id, { notes: "concurrent B" })])
  assert.equal((await api.customers.get(c1.id))!.notes, "concurrent A")
  assert.equal((await api.customers.get(c2.id))!.notes, "concurrent B")
  assert.equal(await count(), n3 + 2)

  // Month lock / unlock and settings are audited.
  await api.monthLocks.set(lastMonth, "OPEN")
  await api.monthLocks.set(lastMonth, "LOCKED")
  const ml = (await log()).slice(0, 2).map((e) => e.action)
  assert.deepEqual(ml, ["MONTH_LOCKED", "MONTH_UNLOCKED"])
  const s = await api.settings.get()
  await api.settings.update({ tdsRate: s.tdsRate + 1 })
  ev = (await log())[0]
  assert.deepEqual([ev.module, ev.changes.map((c) => c.field)], ["Settings", ["tdsRate"]])

  // 15. Filters, search, order and timestamps.
  const all = await log()
  assert.ok(all.every((e, i) => i === 0 || all[i - 1].at >= e.at)) // newest first
  assert.ok(all.filter((e) => matchesAudit(e, { role: "EMPLOYEE" })).every((e) => e.actor.role === "EMPLOYEE"))
  assert.equal(all.filter((e) => matchesAudit(e, { role: "EMPLOYEE", module: "Diesel", action: "UPDATED" })).length, 1) // the later three edits were by the Owner
  assert.equal(all.filter((e) => matchesAudit(e, { recordId: pay.id })).length, 3)
  assert.equal(all.filter((e) => matchesAudit(e, { q: "duplicate voucher" })).length, 1)
  assert.equal(all.filter((e) => matchesAudit(e, { action: "DELETED" })).length, 2)
  assert.equal(all.filter((e) => matchesAudit(e, { from: today, to: today })).length, all.length)
  assert.equal(all.filter((e) => matchesAudit(e, { to: "2000-01-01" })).length, 0)
  assert.equal(all.filter((e) => matchesAudit(e, { user: "Employee (unverified session)" })).length, 2) // diesel create + first edit
  assert.equal(formatAuditTime("2026-10-12T09:00:00.000Z"), "12 Oct 2026, 2:30 pm IST") // stored UTC, shown IST
  const t = (at: string, id: string) => ({ ...all[0], at, id })
  assert.deepEqual(newestFirst([t("2026-10-12T09:00:00Z", "a"), t("2026-10-12T10:00:00Z", "b"), t("2026-10-12T10:00:00Z", "c")]).map((e) => e.id), ["c", "b", "a"]) // same instant → later append first

  // A data reset keeps the audit log, records who did it, and clears "Edited" badges for the new data.
  const before = await count()
  await api.admin.resetDemoData()
  const after = await log()
  assert.equal(after.length, before + 1)
  assert.deepEqual([after[0].action, after[0].actor.role], ["DATA_RESET", "OWNER"])
  assert.equal((await api.audit.editedIds()).length, 0)
  assert.equal((await api.audit.history(entry.id)).length, 0) // ids may be reused by the new demo data
  assert.ok(after.some((e) => e.recordId === entry.id)) // …but the central log still has every old event

  console.log(`audit trail: all checks passed (${after.length} events)`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
