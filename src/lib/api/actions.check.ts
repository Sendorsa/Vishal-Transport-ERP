/**
 * Runnable check for record actions (Edit / Delete / Archive):  npm run check:actions
 * Real API on in-memory demo data. Verifies that every delete is permitted, month-locked, audited
 * with its last snapshot, and that every total, ledger, inventory and carry-forward returns exactly
 * to where it was. See CLAUDE.md → "Record Actions: Edit, Delete and Archive".
 */
import assert from "node:assert/strict"
import { checkTanker, failure, setRole, tankerRecordsOf } from "./test-browser"

async function main() {
  const { api } = await import("./index")
  const { todayISO, round2 } = await import("@/lib/format")
  const { stationLedger, ledgerFor } = await import("@/domain/station-ledger")
  const { inventoryLedger, valueInventory, stockFor } = await import("@/domain/adblue-inventory")
  const { valueTankers, tankerLedger, tankerMoves, tankerPeriod, loadsAsStationPurchases } = await import("@/domain/tanker")

  const today = todayISO()
  const month = today.slice(0, 7)
  const [y, m] = month.split("-").map(Number)
  const ym = (mm: number) => `${mm < 1 ? y - 1 : mm > 12 ? y + 1 : y}-${String(((mm + 11) % 12) + 1).padStart(2, "0")}`
  const lastMonth = ym(m - 1)
  const nextMonth = ym(m + 1)

  setRole("OWNER")
  const TK = await checkTanker()
  const events = async (id: string) => (await api.audit.history(id)).map((e) => e.action)
  const logSize = async () => (await api.audit.list()).length

  /* ---------------------------------------------------------------- Shared fixtures */
  const vehicles = await api.vehicles.list()
  const vehicle = vehicles.find((v) => v.status === "ACTIVE" && v.fuelType === "DIESEL" && v.assignedCustomerId)!
  const customerId = vehicle.assignedCustomerId!
  const station = "dv_raghuveer"
  const odo0 = Math.max(vehicle.odometerKm, ...(await api.diesel.list()).filter((e) => e.vehicleId === vehicle.id).map((e) => e.odometerKm ?? 0))
  const fill = (litres: number, odometerKm: number, extra: object = {}) => ({ date: today, vehicleId: vehicle.id, customerId, vendorId: station, litres, rate: 95, odometerKm, billNo: "ACT", paymentMode: "CREDIT" as const, ...extra })

  // Figures a diesel delete must restore.
  const snapshotTotals = async () => {
    const diesel = await api.diesel.list()
    const loads = await api.tankerLoads.list()
    const purchases = [...diesel, ...loadsAsStationPurchases(loads)]
    const led = ledgerFor(stationLedger(station, purchases, await api.payments.list(), nextMonth), [month])
    const inMonth = diesel.filter((e) => e.date.startsWith(month))
    return {
      vehicleFills: diesel.filter((e) => e.vehicleId === vehicle.id).length,
      customerSpend: round2(inMonth.filter((e) => e.customerId === customerId).reduce((t, e) => t + e.amount, 0)),
      monthSpend: round2(inMonth.reduce((t, e) => t + e.amount, 0)),
      stationPurchased: led.purchased,
      stationCashAtPump: led.cashAtPump,
      stationClosing: led.closing,
      nextOpening: ledgerFor(stationLedger(station, purchases, await api.payments.list(), nextMonth), [nextMonth]).opening,
    }
  }

  /* ---------------------------------------------------------------- 1. Diesel: edit, delete, recalculation */
  const base = await snapshotTotals()
  const credit = await api.diesel.create(fill(100, odo0 + 300))
  const cash = await api.diesel.create(fill(50, odo0 + 600, { paymentMode: "CASH" }))
  await api.diesel.update(credit.id, { ...fill(110, odo0 + 300) }, "Incorrect litres entered")
  const mid = await snapshotTotals()
  assert.equal(round2(mid.customerSpend - base.customerSpend), round2(110 * 95 + 50 * 95))
  assert.equal(round2(mid.stationCashAtPump - base.stationCashAtPump), 4750)
  await api.diesel.remove(credit.id, "Duplicate entry")
  await api.diesel.remove(cash.id, "Check: test record")
  assert.deepEqual(await snapshotTotals(), base) // vehicle history, customer, month, station ledger, cash at pump, carry-forward: all back
  assert.deepEqual(await events(credit.id), ["CREATED", "UPDATED", "DELETED"])
  const del = (await api.audit.history(credit.id)).at(-1)!
  assert.deepEqual([del.reason, del.after, (del.before as { litres: number }).litres, del.module, del.recordType], ["Duplicate entry", null, 110, "Diesel", "Diesel entry"])
  assert.equal((await api.audit.list()).find((e) => e.id === del.id)!.recordExists, false) // history readable after the record is gone
  // Master records survive a transaction delete.
  assert.ok(await api.vehicles.get(vehicle.id))
  assert.ok(await api.customers.get(customerId))
  assert.ok(await api.fuelStations.get(station))

  /* ---------------------------------------------------------------- 2. Diesel Tanker: load, dispenses, inventory, carry-forward */
  const tank = async () => {
    const r = await tankerRecordsOf()
    const led = tankerLedger(tankerMoves(r), TK, nextMonth)
    return { stock: valueTankers(r).stock.get(TK)?.litres ?? 0, closing: tankerPeriod(led, [month]).closing, nextOpening: tankerPeriod(led, [nextMonth]).opening }
  }
  const t0 = await tank()
  const load = await api.tankerLoads.create({ tankerId: TK, date: today, stationId: "dv_lakshmitha", invoiceNo: "ACT-L", litres: 1000, rate: 95, notes: "" })
  const tankerFill = await api.diesel.create(fill(200, odo0 + 900, { vendorId: "dv_tanker", rate: 95, tankerId: TK }))
  const ext = await api.tankerDispenses.create({ tankerId: TK, date: today, vehicleNo: "KA01AB1234", litres: 100, notes: "Personal car" })
  await api.tankerDispenses.update(ext.id, { tankerId: TK, date: today, vehicleNo: "KA01AB1234", litres: 120, notes: "Personal car" }, "Wrong litres")
  await api.tankerLoads.update(load.id, { tankerId: TK, date: today, stationId: "dv_lakshmitha", invoiceNo: "ACT-L", litres: 1000, rate: 94, notes: "" }, "Rate correction")
  assert.deepEqual(await tank(), { stock: t0.stock + 680, closing: t0.closing + 680, nextOpening: t0.nextOpening + 680 })
  // A load whose diesel is already dispensed can't be deleted — refused, nothing recorded, nothing changed.
  const n0 = await logSize()
  await assert.rejects(api.tankerLoads.remove(load.id, "Check: test record"), /Insufficient tanker inventory/)
  assert.equal(await logSize(), n0)
  assert.ok((await api.tankerLoads.list()).some((l) => l.id === load.id))
  await api.tankerDispenses.remove(ext.id, "Entered twice")
  assert.equal((await tank()).stock, t0.stock + 800) // litres back into inventory
  await api.diesel.remove(tankerFill.id, "Check: test record") // a registered dispense is its diesel entry
  assert.equal((await tank()).stock, t0.stock + 1000)
  await api.tankerLoads.remove(load.id, "Check: test record")
  assert.deepEqual(await tank(), t0) // stock, month closing and next month's opening all back
  assert.deepEqual(await events(ext.id), ["CREATED", "UPDATED", "DELETED"])
  assert.deepEqual(await events(load.id), ["CREATED", "UPDATED", "DELETED"])

  /* ---------------------------------------------------------------- 3. AdBlue: purchase + entry, edit, delete */
  const ad = async () => {
    const p = await api.adbluePurchases.list()
    const e = await api.adblue.list()
    const led = inventoryLedger(p, e, nextMonth)
    return { stock: valueInventory(p, e).stockLitres, value: valueInventory(p, e).stockValue, consumed: stockFor(led, [month]).consumed, nextOpening: stockFor(led, [nextMonth]).opening }
  }
  const a0 = await ad()
  const purchase = await api.adbluePurchases.create({ date: today, vendorName: "Action Check Chemicals", product: "AdBlue", buckets: 10, litresPerBucket: 20, pricePerBucket: 900, invoiceNo: "", notes: "" })
  const draw = await api.adblue.create({ vehicleId: vehicle.id, customerId, date: today, closingKm: odo0 + 1000, quantityLitres: 15, invoiceNo: "", notes: "" })
  await api.adblue.update(draw.id, { vehicleId: vehicle.id, customerId, date: today, closingKm: odo0 + 1000, quantityLitres: 20, invoiceNo: "", notes: "" }, "Incorrect litres entered")
  assert.deepEqual([(await ad()).stock, (await ad()).consumed], [a0.stock + 180, a0.consumed + 20])
  await assert.rejects(api.adbluePurchases.remove(purchase.id, "Check: test record"), /Insufficient AdBlue inventory/) // its AdBlue is in use
  await api.adblue.remove(draw.id, "Wrong vehicle")
  const a1 = await ad()
  assert.deepEqual([a1.stock, a1.consumed, a1.nextOpening], [a0.stock + 200, a0.consumed, a0.nextOpening + 200]) // stock, consumption, carry-forward
  await api.adbluePurchases.update(purchase.id, { date: today, vendorName: "Action Check Chemicals", product: "AdBlue", buckets: 5, litresPerBucket: 20, pricePerBucket: 900, invoiceNo: "", notes: "" })
  await api.adbluePurchases.remove(purchase.id, "Cancelled order")
  assert.deepEqual(await ad(), a0)
  assert.deepEqual(await events(draw.id), ["CREATED", "UPDATED", "DELETED"])
  assert.equal((await api.audit.history(draw.id)).at(-1)!.reason, "Wrong vehicle")
  assert.deepEqual(await events(purchase.id), ["CREATED", "UPDATED", "DELETED"])

  /* ---------------------------------------------------------------- 4. Fuel station payment: edit, delete, balances */
  const b0 = await snapshotTotals()
  const pay = await api.fuelStationPayments.create({ stationId: station, paymentDate: today, amount: 10000, paymentMode: "NEFT", notes: "", companyCode: "VT" })
  assert.equal(round2(b0.stationClosing - (await snapshotTotals()).stationClosing), 10000)
  await api.fuelStationPayments.update(pay.id, { paymentDate: today, amount: 12000, paymentMode: "CASH", notes: "" }, "Wrong payment amount")
  const b1 = await snapshotTotals()
  assert.deepEqual([round2(b0.stationClosing - b1.stationClosing), round2(b0.nextOpening - b1.nextOpening)], [12000, 12000]) // closing and next month's opening
  await api.fuelStationPayments.remove(pay.id, "Duplicate voucher")
  assert.deepEqual(await snapshotTotals(), b0)
  assert.deepEqual(await events(pay.id), ["PAYMENT_RECORDED", "UPDATED", "DELETED"])

  /* ---------------------------------------------------------------- 5. Authorization (API, not just the UI) */
  const entry = await api.diesel.create(fill(80, odo0 + 1200))
  const loadB = await api.tankerLoads.create({ tankerId: TK, date: today, stationId: "dv_lakshmitha", invoiceNo: "", litres: 100, rate: 95, notes: "" })
  const payB = await api.fuelStationPayments.create({ stationId: station, paymentDate: today, amount: 500, paymentMode: "UPI", notes: "", companyCode: "VT" })
  const trip = (await api.trips.list()).find((t) => !t.invoiceId && t.date.startsWith(month))!
  const n1 = await logSize()
  for (const [role, call, msg] of [
    ["EMPLOYEE", () => api.diesel.remove(entry.id, "Check: test record"), /can't delete fuel records/],
    ["EMPLOYEE", () => api.tankerLoads.remove(loadB.id, "Check: test record"), /can't delete fuel records/],
    ["EMPLOYEE", () => api.adbluePurchases.remove("anything", "Check: test record"), /can't delete fuel records/],
    ["EMPLOYEE", () => api.fuelStationPayments.remove(payB.id, "Check: test record"), /can't delete payment records/],
    ["EMPLOYEE", () => api.fuelStationPayments.update(payB.id, { paymentDate: today, amount: 1, paymentMode: "UPI", notes: "" }), /can't edit payment records/],
    ["EMPLOYEE", () => api.payments.remove(payB.id, "Check: test record"), /can't delete payment records/],
    ["EMPLOYEE", () => api.trips.remove(trip.id, "Check: test record"), /can't delete trip records/],
    // A browser still holding a removed role (31 Oct 2026) acts as an Employee — never the Owner fallback.
    ["ACCOUNTANT", () => api.fuelStationPayments.update(payB.id, { paymentDate: today, amount: 1, paymentMode: "UPI", notes: "" }), /can't edit payment records/],
    ["OPS_MANAGER", () => api.diesel.remove(entry.id, "Check: test record"), /can't delete fuel records/],
  ] as const) {
    setRole(role)
    await assert.rejects(call(), msg)
  }
  setRole("OWNER")
  assert.equal(await logSize(), n1) // refused actions record nothing
  assert.ok(await api.diesel.get(entry.id))
  assert.ok(await api.trips.get(trip.id))
  // Roles keep what their permissions grant: Employees edit fuel entries; Dev edits payments and deletes fuel entries.
  setRole("EMPLOYEE")
  await api.diesel.update(entry.id, fill(81, odo0 + 1200))
  setRole("DEV")
  await api.fuelStationPayments.update(payB.id, { paymentDate: today, amount: 600, paymentMode: "UPI", notes: "" })
  await api.diesel.remove(entry.id, "Check: test record")
  setRole("OWNER")
  assert.deepEqual(await events(entry.id), ["CREATED", "UPDATED", "DELETED"])
  assert.deepEqual((await api.audit.history(entry.id)).map((e) => e.actor.role), ["OWNER", "EMPLOYEE", "DEV"])

  /* ---------------------------------------------------------------- 6. Month lock */
  const old = (await api.diesel.list()).find((e) => e.date.startsWith(lastMonth) && e.vendorId !== "dv_tanker")!
  setRole("EMPLOYEE") // may edit fuel records, but not in a locked month (Dev and the Owner may)
  await assert.rejects(api.diesel.update(old.id, { date: old.date, vendorId: old.vendorId, litres: old.litres + 1, rate: old.rate, odometerKm: old.odometerKm, billNo: old.billNo, paymentMode: old.paymentMode }), /is locked/)
  await assert.rejects(api.diesel.remove(old.id, "Check: test record"), /can't delete/) // …and deletes nothing
  setRole("OWNER") // the Owner can change any month (Monthly Sheet Lock)…
  assert.ok(await api.diesel.get(old.id))
  await api.diesel.remove(old.id, "Owner correction")
  assert.deepEqual(await events(old.id), ["DELETED"])
  // Station payments: only the Owner and Dev handle money; the Employee is refused outright.
  const oldPay = (await api.payments.list()).find((p) => p.categoryCode === "DIESEL_SETTLEMENT" && p.date < `${lastMonth}-01`)!
  setRole("EMPLOYEE")
  await assert.rejects(api.fuelStationPayments.remove(oldPay.id, "Check: test record"), /can't/)
  setRole("OWNER")
  assert.ok(await api.payments.get(oldPay.id))

  /* ---------------------------------------------------------------- 7. Repeated clicks, failures */
  const dup = await api.diesel.create(fill(60, odo0 + 1500))
  await Promise.all([api.diesel.remove(dup.id, "Check: test record"), api.diesel.remove(dup.id, "Check: test record")]) // double click
  assert.deepEqual(await events(dup.id), ["CREATED", "DELETED"]) // one deletion, one event
  const keep = await api.diesel.create(fill(60, odo0 + 1800))
  failure.key = "vt:auditEvents"
  failure.once = true
  await assert.rejects(api.diesel.remove(keep.id, "Check: test record"), /simulated storage failure/) // the audit write fails…
  assert.ok(await api.diesel.get(keep.id)) // …so the delete is rolled back
  assert.deepEqual(await events(keep.id), ["CREATED"])

  /* ---------------------------------------------------------------- 8. Protected records: archive, never delete */
  for (const [name, svc] of [["customers", api.customers], ["vehicles", api.vehicles], ["drivers", api.drivers], ["fuelStations", api.fuelStations]] as const) {
    assert.ok(!("remove" in svc) && !("delete" in svc), `${name} must have no delete`)
    assert.ok("archive" in svc && "restore" in svc, `${name} must archive / restore`)
  }
  assert.ok(!("remove" in api.invoices) && "cancel" in api.invoices) // invoices are cancelled, kept for audit
  assert.ok(!("remove" in api.monthLocks) && !("remove" in api.settings))
  assert.deepEqual(Object.keys(api.audit).sort(), ["checkRestore", "editedIds", "history", "list", "markReviewed", "restoreDeleted", "unreviewedDeletions"]) // audit events can't be deleted, even your own

  /* ---------------------------------------------------------------- 9. Mandatory deletion reason (API, every delete path) */
  const r = await api.diesel.create(fill(70, odo0 + 2100))
  const n2 = await logSize()
  for (const bad of ["", "   ", "\t \n", "ab", undefined as unknown as string]) await assert.rejects(api.diesel.remove(r.id, bad), /reason/i)
  for (const call of [
    () => api.adblue.remove("x", " "),
    () => api.adbluePurchases.remove("x", ""),
    () => api.tankerLoads.remove("x", "  "),
    () => api.tankerDispenses.remove("x", ""),
    () => api.fuelStationPayments.remove("x", " "),
    () => api.payments.remove("x", ""),
    () => api.trips.remove("x", "   "),
  ])
    await assert.rejects(call(), /reason/i)
  assert.equal(await logSize(), n2) // nothing recorded
  assert.ok(await api.diesel.get(r.id)) // nothing deleted
  await api.diesel.remove(r.id, "  Wrong vehicle selected  ")
  const rd = (await api.audit.history(r.id)).at(-1)!
  assert.deepEqual([rd.action, rd.reason, (rd.before as { amount: number }).amount, (rd.before as { litres: number }).litres], ["DELETED", "Wrong vehicle selected", 6650, 70]) // trimmed reason + values before deletion
  assert.equal((await api.audit.list()).find((e) => e.id === rd.id)!.reason, "Wrong vehicle selected") // still there with the record gone

  /* ---------------------------------------------------------------- 10. Unreviewed deletions (Owner's badge) */
  const count = () => api.audit.unreviewedDeletions()
  const c0 = await count()
  assert.equal(c0, (await api.audit.list()).filter((e) => e.action === "DELETED").length) // nothing reviewed yet
  // Creating, editing, archiving, restoring and failed deletes don't count.
  const x = await api.diesel.create(fill(40, odo0 + 2400))
  await api.diesel.update(x.id, fill(41, odo0 + 2400), "fix")
  const cust = (await api.customers.list()).find((c) => c.status === "ACTIVE")!
  await api.customers.archive(cust.id)
  await api.customers.restore(cust.id)
  await assert.rejects(api.diesel.remove(x.id, " "), /reason/i)
  setRole("EMPLOYEE")
  await assert.rejects(api.diesel.remove(x.id, "Not allowed"), /can't delete/)
  setRole("OWNER")
  assert.equal(await count(), c0)
  // Each successful deletion is one more — events, not records (a re-entered and re-deleted entry counts twice).
  await api.diesel.remove(x.id, "Duplicate entry")
  const again = await api.diesel.create(fill(41, odo0 + 2400))
  await api.diesel.remove(again.id, "Duplicate entry again")
  await Promise.all([api.diesel.remove(again.id, "Double click"), api.diesel.remove(again.id, "Double click")]) // already gone: no event
  assert.equal(await count(), c0 + 2)
  // Only the Owner and Dev see or clear the count.
  for (const role of ["EMPLOYEE", "ACCOUNTANT"] as const) {
    setRole(role)
    await assert.rejects(count(), /Only the Owner or Dev/)
    await assert.rejects(api.audit.markReviewed([x.id]), /Only the Owner or Dev/)
  }
  setRole("DEV")
  assert.equal(await count(), c0 + 2) // Dev sees the same count (reviewing is tested below as the Owner)
  setRole("OWNER")
  // Opening the log reviews nothing.
  await api.audit.list()
  assert.equal(await count(), c0 + 2)
  // Reviewing one event; repeats, retries and non-deletion ids change nothing.
  const deletions = (await api.audit.list()).filter((e) => e.action === "DELETED" && !e.review)
  const createdId = (await api.audit.list()).find((e) => e.action === "CREATED")!.id
  assert.equal(await api.audit.markReviewed([deletions[0].id, deletions[0].id, createdId, "nonsense"]), 1)
  assert.equal(await api.audit.markReviewed([deletions[0].id]), 0)
  assert.equal(await count(), c0 + 1)
  const reviewed = (await api.audit.list()).find((e) => e.id === deletions[0].id)!
  assert.deepEqual([reviewed.action, reviewed.reason, reviewed.review?.actor.role], [deletions[0].action, deletions[0].reason, "OWNER"]) // the event itself is unchanged
  // Mark all shown; the count reaches 0 and the history stays.
  await api.audit.markReviewed(deletions.map((e) => e.id))
  assert.equal(await count(), 0)
  assert.equal((await api.audit.list()).filter((e) => e.action === "DELETED").length, c0 + 2)
  // A new deletion shows again; reviews survive a data reset.
  const late = await api.diesel.create(fill(42, odo0 + 2700))
  await api.diesel.remove(late.id, "Wrong fuel station")
  assert.equal(await count(), 1)
  await api.admin.resetDemoData()
  assert.equal(await count(), 1)

  // A vehicle edit that changes the customer (edit form, Diesel → Add existing vehicle) is one call with one version:
  // it transfers first, then saves the other fields. It used to refuse itself as someone else's change (4 Nov 2026).
  {
    setRole("OWNER")
    const { withVersions, ConflictError } = await import("@/lib/versions")
    const v = (await api.vehicles.list()).find((x) => x.status === "ACTIVE" && x.assignedCustomerId)!
    const other = (await api.customers.list()).find((c) => c.status === "ACTIVE" && c.id !== v.assignedCustomerId && c.companyCode === v.companyCode)!
    const { id, createdAt, updatedAt, ...data } = v
    void [createdAt]
    const saved = await withVersions({ [id]: updatedAt }, () => api.vehicles.update(id, { ...data, assignedCustomerId: other.id, notes: "moved" }))
    assert.deepEqual([saved.assignedCustomerId, saved.notes], [other.id, "moved"])
    await assert.rejects(withVersions({ [id]: updatedAt }, () => api.vehicles.update(id, { ...data, assignedCustomerId: other.id, notes: "stale" })), (e: unknown) => e instanceof ConflictError, "a stale screen is still refused")
  }

  console.log("record actions: all checks passed")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
