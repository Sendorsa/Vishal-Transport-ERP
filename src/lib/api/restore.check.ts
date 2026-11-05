/**
 * Runnable check for Restore / Push Back of deleted records:  npm run check:restore
 * Real API on in-memory demo data. Verifies the full workflow — original id and values back, the
 * DELETED event kept, a separate RESTORED event, badge and review status, permissions, reasons,
 * conflicts (stock, odometer, voucher numbers, receipts, duplicates) and that every
 * total, ledger and carry-forward is exactly as before the deletion.
 */
import assert from "node:assert/strict"
import { checkTanker, failure, setRole, tankerRecordsOf } from "./test-browser"

async function main() {
  const { api, PossibleDuplicateError } = await import("./index")
  const { todayISO, round2 } = await import("@/lib/format")
  const { appendAuditEvent, readCollection, writeCollection } = await import("@/lib/storage/local-store")
  const { buildEvent } = await import("@/domain/audit")
  const { stationLedger, ledgerFor } = await import("@/domain/station-ledger")
  const { inventoryLedger, valueInventory, stockFor } = await import("@/domain/adblue-inventory")
  const { valueTankers, tankerLedger, tankerMoves, tankerPeriod, loadsAsStationPurchases } = await import("@/domain/tanker")

  const today = todayISO()
  const month = today.slice(0, 7)
  const [y, m] = month.split("-").map(Number)
  const nextMonth = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`
  setRole("OWNER")
  const TK = await checkTanker()

  const log = () => api.audit.list()
  const badge = () => api.audit.unreviewedDeletions()
  const actions = async (id: string) => (await api.audit.history(id)).map((e) => (e.restoresEventId ? "RESTORED(from deletion)" : e.action))
  const lastDeletion = async (id: string) => (await log()).find((e) => e.recordId === id && e.action === "DELETED")!
  const restore = (eventId: string, reason = "Deleted by mistake — restoring", confirmNotDuplicate?: boolean) => api.audit.restoreDeleted(eventId, reason, { confirmNotDuplicate })

  const vehicles = await api.vehicles.list()
  const vehicle = vehicles.find((v) => v.status === "ACTIVE" && v.fuelType === "DIESEL" && v.assignedCustomerId)!
  const customerId = vehicle.assignedCustomerId!
  const station = "dv_raghuveer"
  const odo0 = Math.max(vehicle.odometerKm, ...(await api.diesel.list()).filter((e) => e.vehicleId === vehicle.id).map((e) => e.odometerKm ?? 0))
  const fill = (litres: number, odometerKm: number, extra: object = {}) => ({ date: today, vehicleId: vehicle.id, customerId, vendorId: station, litres, rate: 95, odometerKm, billNo: `R${odometerKm}`, paymentMode: "CREDIT" as const, ...extra })

  const totals = async () => {
    const diesel = await api.diesel.list()
    const purchases = [...diesel, ...loadsAsStationPurchases(await api.tankerLoads.list())]
    const rows = stationLedger(station, purchases, await api.payments.list(), nextMonth)
    const inMonth = diesel.filter((e) => e.date.startsWith(month))
    return {
      vehicleFills: diesel.filter((e) => e.vehicleId === vehicle.id).length,
      customerSpend: round2(inMonth.filter((e) => e.customerId === customerId).reduce((t, e) => t + e.amount, 0)),
      station: ledgerFor(rows, [month]),
      nextOpening: ledgerFor(rows, [nextMonth]).opening,
    }
  }

  /* ---------------------------------------------------------------- 1–8. Diesel entry: delete → restore, the whole workflow */
  const e1 = await api.diesel.create(fill(100, odo0 + 300))
  const t1 = await totals()
  const b0 = await badge()
  await api.diesel.remove(e1.id, "Wrong vehicle selected")
  const del1 = await lastDeletion(e1.id)
  assert.equal(await badge(), b0 + 1) // pending-review count up
  assert.equal(del1.reason, "Wrong vehicle selected")
  assert.deepEqual((await log()).find((e) => e.id === del1.id)!.restorableType, true)
  const check = await api.audit.checkRestore(del1.id)
  assert.ok(check.ok)
  const restored = await restore(del1.id, "  Restoring this diesel entry because it was deleted by mistake.  ")
  // Back with its original id, createdAt, customer and station; every total as before the deletion.
  const back = (await api.diesel.get(e1.id))!
  assert.deepEqual([back.id, back.createdAt, back.vehicleId, back.customerId, back.vendorId, back.litres, back.amount], [e1.id, e1.createdAt, e1.vehicleId, e1.customerId, e1.vendorId, 100, 9500])
  assert.equal(restored.id, e1.id)
  assert.deepEqual(await totals(), t1)
  // The deletion event stays; a separate RESTORED event points to it.
  assert.ok((await log()).some((e) => e.id === del1.id && e.action === "DELETED" && e.reason === "Wrong vehicle selected"))
  const r1 = (await api.audit.history(e1.id)).at(-1)!
  assert.deepEqual([r1.action, r1.restoresEventId, r1.reason, r1.actor.role, r1.before, (r1.after as { amount: number }).amount], ["RESTORED", del1.id, "Restoring this diesel entry because it was deleted by mistake.", "OWNER", null, 9500])
  assert.match(r1.note ?? "", /Adds ₹9,500\.00 back/)
  assert.deepEqual(await actions(e1.id), ["CREATED", "DELETED", "RESTORED(from deletion)"])
  // Badge and status: restored deletions need no action, but stay visible and can still be marked reviewed.
  assert.equal(await badge(), b0)
  const row1 = (await log()).find((e) => e.id === del1.id)!
  assert.deepEqual([row1.restoredBy?.id, row1.review, row1.recordExists], [r1.id, null, true])
  assert.equal(await api.audit.markReviewed([del1.id]), 1)
  assert.equal(await badge(), b0) // reviewing a restored deletion doesn't move the count

  /* ---------------------------------------------------------------- 9. Restoring twice is refused — also on concurrent retries */
  await assert.rejects(restore(del1.id), /Already restored/)
  const e2 = await api.diesel.create(fill(50, odo0 + 600))
  await api.diesel.remove(e2.id, "Duplicate entry")
  const del2 = await lastDeletion(e2.id)
  const results = await Promise.allSettled([restore(del2.id), restore(del2.id)])
  assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"])
  assert.equal((await api.diesel.list()).filter((e) => e.id === e2.id).length, 1) // one record, not two
  assert.equal((await log()).filter((e) => e.restoresEventId === del2.id).length, 1) // one RESTORED event

  /* ---------------------------------------------------------------- 10. Restoration reason is mandatory (API) */
  const e3 = await api.diesel.create(fill(60, odo0 + 900))
  await api.diesel.remove(e3.id, "Entered twice")
  const del3 = await lastDeletion(e3.id)
  const n0 = (await log()).length
  for (const bad of ["", "   ", "\t\n", "ok", undefined as unknown as string]) await assert.rejects(api.audit.restoreDeleted(del3.id, bad), /reason/i)
  assert.equal((await log()).length, n0)
  assert.equal(await api.diesel.get(e3.id), null)

  /* ---------------------------------------------------------------- 11. Owner-level authority restores: Owner, Dev and the Employee (5 Nov 2026) */
  for (const role of ["EMPLOYEE", "ACCOUNTANT"] as const) {
    setRole(role) // a removed role acts as the Employee
    assert.ok((await api.audit.checkRestore(del3.id)).ok, `${role} may restore`)
  }
  setRole("DEV")
  assert.ok((await api.audit.checkRestore(del3.id)).ok, "Dev may restore (owner, 3 Nov 2026)")
  setRole("OWNER")
  assert.equal(await api.diesel.get(e3.id), null)

  /* ---------------------------------------------------------------- 15. A later deletion is a new, independent event */
  await restore(del3.id)
  await api.diesel.update(e3.id, fill(61, odo0 + 900), "litres")
  await api.diesel.remove(e3.id, "Deleted again — really wrong")
  const del3b = await lastDeletion(e3.id)
  assert.notEqual(del3b.id, del3.id)
  assert.equal((del3b.before as { litres: number }).litres, 61) // its own snapshot
  await assert.rejects(restore(del3.id), /Already restored/) // the old deletion can't be replayed
  assert.ok((await api.audit.checkRestore(del3b.id)).ok)
  await restore(del3b.id)
  assert.deepEqual(await actions(e3.id), ["CREATED", "DELETED", "RESTORED(from deletion)", "UPDATED", "DELETED", "RESTORED(from deletion)"])
  assert.equal((await api.diesel.get(e3.id))!.litres, 61)

  /* ---------------------------------------------------------------- 12. Conflicts: possible duplicate needs explicit confirmation */
  const e4 = await api.diesel.create(fill(70, odo0 + 1200))
  await api.diesel.remove(e4.id, "Wrong litres — will re-enter")
  const del4 = await lastDeletion(e4.id)
  const reentered = await api.diesel.create(fill(72, odo0 + 1200)) // re-entered after the deletion
  const c4 = await api.audit.checkRestore(del4.id)
  assert.ok(c4.ok && c4.duplicate?.id === reentered.id)
  const n1 = (await log()).length
  await assert.rejects(restore(del4.id), (err) => err instanceof PossibleDuplicateError)
  assert.equal(await api.diesel.get(e4.id), null)
  assert.equal((await log()).length, n1)
  await restore(del4.id, "It really was a second fill", true)
  assert.match((await api.audit.history(e4.id)).at(-1)!.note ?? "", /confirmed it is not a duplicate/)
  await api.diesel.remove(reentered.id, "Cleanup")

  /* ---------------------------------------------------------------- 13. Diesel Tanker: inventory, negative-stock conflict, tanker fills */
  const tank = async () => {
    const r = await tankerRecordsOf()
    const led = tankerLedger(tankerMoves(r), TK, nextMonth)
    return { stock: valueTankers(r).stock.get(TK)?.litres ?? 0, closing: tankerPeriod(led, [month]).closing, nextOpening: tankerPeriod(led, [nextMonth]).opening }
  }
  const tank0 = await tank()
  const load = await api.tankerLoads.create({ tankerId: TK, date: today, stationId: "dv_lakshmitha", invoiceNo: "RL", litres: 1000, rate: 95, notes: "" })
  const x = await api.tankerDispenses.create({ tankerId: TK, date: today, vehicleNo: "KA01AB1234", litres: 300, notes: "Personal car" })
  const withX = await tank()
  await api.tankerDispenses.remove(x.id, "Wrong litres")
  const delX = await lastDeletion(x.id)
  const big = await api.tankerDispenses.create({ tankerId: TK, date: today, vehicleNo: "KA02CD5678", litres: 800, notes: "Hired truck" })
  const cx = await api.audit.checkRestore(delX.id)
  assert.ok(!cx.ok && /Insufficient tanker inventory/.test(cx.reason)) // would go negative: blocked
  await assert.rejects(restore(delX.id), /Insufficient tanker inventory/)
  await api.tankerDispenses.remove(big.id, "Wrong vehicle")
  await restore(delX.id)
  assert.deepEqual(await tank(), withX) // stock, month closing, next month's opening
  // A registered tanker fill comes back stored exactly as created: its source rate and amount (answer 23).
  const tf = await api.diesel.create(fill(200, odo0 + 1500, { vendorId: "dv_tanker", rate: 96.5, tankerId: TK }))
  await api.diesel.remove(tf.id, "Wrong vehicle")
  await restore((await lastDeletion(tf.id)).id)
  const raw = readCollection("diesel_entries").find((e) => e.id === tf.id)!
  assert.deepEqual([raw.rate, raw.amount, raw.paymentMode, raw.tankerId], [96.5, 19300, "CREDIT", TK])
  // An older fill saved without a rate (imports) also comes back as it was: rate 0, costed at the average on read.
  const legacy = { ...fill(100, odo0 + 1600, { vendorId: "dv_tanker", rate: 0, tankerId: TK }), id: "dsl_restore_legacy", companyCode: vehicle.companyCode, amount: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
  writeCollection("diesel_entries", [...readCollection("diesel_entries"), legacy as never])
  const legacyCost = (await api.diesel.list()).find((e) => e.id === legacy.id)!.amount
  await api.diesel.remove(legacy.id, "Wrong vehicle")
  await restore((await lastDeletion(legacy.id)).id)
  const rawLegacy = readCollection("diesel_entries").find((e) => e.id === legacy.id)!
  assert.deepEqual([rawLegacy.rate, rawLegacy.amount], [0, 0])
  assert.equal((await api.diesel.list()).find((e) => e.id === legacy.id)!.amount, legacyCost)
  await api.diesel.remove(legacy.id, "Cleanup")
  // Loads: delete (once its diesel is free), restore, back to the same stock.
  await api.diesel.remove(tf.id, "Cleanup")
  await api.tankerDispenses.remove(x.id, "Cleanup")
  await api.tankerLoads.remove(load.id, "Entered against the wrong station")
  await restore((await lastDeletion(load.id)).id)
  assert.equal((await tank()).stock, tank0.stock + 1000)
  await api.tankerLoads.remove(load.id, "Cleanup")
  assert.deepEqual(await tank(), tank0)

  /* ---------------------------------------------------------------- 13. AdBlue: draw and purchase, stock and odometer conflict */
  const ad = async () => {
    const p = await api.adbluePurchases.list()
    const e = await api.adblue.list()
    const led = inventoryLedger(p, e, nextMonth)
    return { stock: valueInventory(p, e).stockLitres, value: valueInventory(p, e).stockValue, consumed: stockFor(led, [month]).consumed, nextOpening: stockFor(led, [nextMonth]).opening }
  }
  const purchase = await api.adbluePurchases.create({ date: today, vendorName: "Restore Check Chemicals", product: "AdBlue", buckets: 10, litresPerBucket: 20, pricePerBucket: 900, invoiceNo: "", notes: "" })
  const draw = await api.adblue.create({ vehicleId: vehicle.id, customerId, date: today, closingKm: odo0 + 2000, quantityLitres: 15, invoiceNo: "", notes: "" })
  const adWith = await ad()
  await api.adblue.remove(draw.id, "Wrong vehicle")
  const delD = await lastDeletion(draw.id)
  const clash = await api.adblue.create({ vehicleId: vehicle.id, customerId, date: today, closingKm: odo0 + 2000, quantityLitres: 5, invoiceNo: "", notes: "" })
  const cd = await api.audit.checkRestore(delD.id)
  assert.ok(!cd.ok && /no longer fits/.test(cd.reason)) // odometer order would break: blocked
  await api.adblue.remove(clash.id, "Cleanup")
  await restore(delD.id)
  assert.deepEqual(await ad(), adWith) // stock, value, consumption, carry-forward
  assert.equal(readCollection("adblue_entries").find((e) => e.id === draw.id)!.amount, 0) // stored as a draw (cost on read)
  await api.adblue.remove(draw.id, "Cleanup")
  await api.adbluePurchases.remove(purchase.id, "Cancelled order")
  await restore((await lastDeletion(purchase.id)).id)
  assert.ok((await api.adbluePurchases.list()).some((p) => p.id === purchase.id))

  /* ---------------------------------------------------------------- 13. Fuel station payment: ledger, voucher-number conflict, an old month */
  const pBase = await totals()
  const pay = await api.fuelStationPayments.create({ stationId: station, paymentDate: today, amount: 10000, paymentMode: "NEFT", notes: "", companyCode: "VT" })
  const payNo = (await api.payments.get(pay.id))!.paymentNo
  const pWith = await totals()
  await api.fuelStationPayments.remove(pay.id, "Duplicate payment entry")
  const delP = await lastDeletion(pay.id)
  assert.deepEqual(await totals(), pBase)
  const reuse = await api.fuelStationPayments.create({ stationId: station, paymentDate: today, amount: 1, paymentMode: "UPI", notes: "", companyCode: "VT" })
  assert.equal((await api.payments.get(reuse.id))!.paymentNo, payNo) // the freed number was reused
  const cp = await api.audit.checkRestore(delP.id)
  assert.ok(!cp.ok && /has since been used/.test(cp.reason))
  await api.fuelStationPayments.remove(reuse.id, "Test voucher")
  await restore(delP.id)
  const pAfter = await totals()
  assert.deepEqual([pAfter.station.paid, pAfter.station.closing, pAfter.nextOpening], [pWith.station.paid, pWith.station.closing, pWith.nextOpening]) // paid, closing, next opening
  assert.equal((await api.payments.get(pay.id))!.paymentNo, payNo)
  // An older station payment: no grace period since 31 Oct 2026 — the Owner can push it back (the Monthly Sheet Lock
  // lets the Owner change a locked month); its ledger month and paid-against month are as they were.
  const old = readCollection("payments").find((p) => p.categoryCode === "DIESEL_SETTLEMENT" && p.date < `${month}-01` && p.date.slice(0, 7) !== (m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`))!
  writeCollection("payments", readCollection("payments").filter((p) => p.id !== old.id)) // fixture: as if deleted while its month was still open
  const fakeDel = buildEvent({ action: "DELETED", module: "Fuel Stations", recordType: "Fuel station payment", recordId: old.id, label: old.paymentNo, recordDate: old.date, before: old, reason: "Fixture" }, { kind: "SESSION", userId: null, name: null, role: "OWNER" }, "aud_fixture_old", new Date().toISOString())
  appendAuditEvent(fakeDel)
  const cl = await api.audit.checkRestore(fakeDel.id)
  assert.ok(cl.ok, cl.ok ? "" : cl.reason)
  await restore(fakeDel.id)
  assert.equal((await api.payments.get(old.id))!.date, old.date)

  /* ---------------------------------------------------------------- 13. Receipt: never settles an invoice twice */
  const views = await api.invoices.list()
  const receipt = (await api.payments.list()).find((p) => p.direction === "IN" && p.allocations.length === 1 && views.find((i) => i.id === p.allocations[0].invoiceId)?.status === "ISSUED")!
  await api.payments.remove(receipt.id, "Wrong customer")
  const delR = await lastDeletion(receipt.id)
  const replacement = await api.payments.create({ ...receipt, date: today, reference: "re-received", allocations: receipt.allocations.map((a) => ({ ...a })) } as never)
  const cr = await api.audit.checkRestore(delR.id)
  assert.ok(!cr.ok && /settle it twice/.test(cr.reason))
  await api.payments.remove(replacement.id, "Cleanup")
  await restore(delR.id)
  assert.deepEqual((await api.payments.get(receipt.id))!.allocations, receipt.allocations)

  /* ---------------------------------------------------------------- Trip */
  const trip = (await api.trips.list()).find((t) => !t.invoiceId && t.date.startsWith(month))!
  const revenue = async () => round2((await api.trips.list()).filter((t) => t.customerId === trip.customerId).reduce((s, t) => s + t.revenue, 0))
  const rev0 = await revenue()
  await api.trips.remove(trip.id, "Entered against the wrong customer")
  await restore((await lastDeletion(trip.id)).id)
  const tripBack = (await api.trips.get(trip.id))!
  assert.deepEqual([tripBack.tripNo, tripBack.createdAt, tripBack.revenue], [trip.tripNo, trip.createdAt, trip.revenue])
  assert.equal(await revenue(), rev0)

  /* ---------------------------------------------------------------- 14. Master records: archive / restore only, history intact */
  const assignmentsBefore = JSON.stringify(readCollection("vehicle_assignments").filter((a) => a.vehicleId === vehicle.id))
  await api.vehicles.archive(vehicle.id)
  const archived = (await log())[0]
  const ca = await api.audit.checkRestore(archived.id)
  assert.ok(!ca.ok && /Only deletion events/.test(ca.reason)) // no "push back" for archiving — use Restore on the record
  await api.vehicles.restore(vehicle.id)
  assert.equal(JSON.stringify(readCollection("vehicle_assignments").filter((a) => a.vehicleId === vehicle.id)), assignmentsBefore)
  assert.equal(readCollection("vehicles").filter((v) => v.id === vehicle.id).length, 1) // no duplicate
  assert.ok(!("remove" in api.vehicles) && !("remove" in api.customers) && !("remove" in api.drivers) && !("remove" in api.fuelStations))

  /* ---------------------------------------------------------------- Review status: restore never touches other deletions */
  const e5 = await api.diesel.create(fill(30, odo0 + 2400))
  const e6 = await api.diesel.create(fill(31, odo0 + 2700))
  await api.diesel.remove(e5.id, "Duplicate one")
  await api.diesel.remove(e6.id, "Duplicate two")
  const [d5, d6] = [await lastDeletion(e5.id), await lastDeletion(e6.id)]
  await api.audit.markReviewed([d5.id]) // reviewed first…
  const before = await badge()
  await restore(d5.id) // …then restored: the count doesn't move again
  assert.equal(await badge(), before)
  await restore(d6.id) // unreviewed → restored: one less needing action
  assert.equal(await badge(), before - 1)
  const rows = await log()
  assert.deepEqual([rows.find((e) => e.id === d5.id)!.review !== null, rows.find((e) => e.id === d6.id)!.review], [true, null]) // restore didn't mark d6 reviewed
  assert.equal(rows.filter((e) => e.action === "DELETED" && !e.review && !e.restoredBy).length, await badge()) // badge = actual states

  /* ---------------------------------------------------------------- Atomic: a failed audit write leaves nothing restored */
  const e7 = await api.diesel.create(fill(20, odo0 + 3000))
  await api.diesel.remove(e7.id, "Wrong bill")
  const d7 = await lastDeletion(e7.id)
  failure.key = "vt:auditEvents"
  failure.once = true
  await assert.rejects(restore(d7.id), /simulated storage failure/)
  assert.equal(await api.diesel.get(e7.id), null)
  assert.equal((await log()).filter((e) => e.restoresEventId === d7.id).length, 0)
  await restore(d7.id) // and it can still be restored afterwards
  assert.ok(await api.diesel.get(e7.id))

  /* ---------------------------------------------------------------- Deletions from before a data reset can't be pushed into the new data */
  await api.diesel.remove(e7.id, "Before the reset")
  const d7b = await lastDeletion(e7.id)
  await api.admin.resetDemoData()
  const cz = await api.audit.checkRestore(d7b.id)
  assert.ok(!cz.ok && /before the data was reset/.test(cz.reason))

  console.log("restore: all checks passed")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
