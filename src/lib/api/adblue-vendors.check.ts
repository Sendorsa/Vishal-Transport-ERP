/**
 * Vendor-based AdBlue inventory (owner, 16 Nov 2026): npm run check:adblue-vendors. Real API on in-memory demo data
 * (nothing touches real browser data), clock fixed at 10 Nov 2026, 10:00 IST.
 *
 * The vendor master (create, duplicates, edit, archive / restore, who may), purchases attributed to their vendor at
 * their own rate, stock draws naming the vendor whose stock they take (FIFO across that vendor's batches, never another
 * vendor's), vendor attribution on every entry, the vendor ledger reconciling with the company's, edit / delete /
 * restore putting stock back, direct purchases never touching bulk stock, records saved before vendor tracking left
 * unchanged, the month lock, and two draws at once never overdrawing a vendor.
 */
import assert from "node:assert/strict"
import { setRole } from "./test-browser"

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
  const { todayISO } = await import("@/lib/format")
  const { valueInventory, vendorLedger, inventoryLedger, stockDraws, stockFor, NO_VENDOR } = await import("@/domain/adblue-inventory")
  const { readCollection, writeCollection, migrateStorage, readAuditEvents } = await import("@/lib/storage/local-store")
  assert.equal(todayISO(), "2026-11-10")
  setRole("OWNER")

  /* ---------------------------------------------------------------- 1–4. the vendor master; pricing */
  const A = await api.adblueVendors.create({ name: "  Vendor   A ", defaultRate: 45, contactPerson: "Ravi", phone: "98450 11111", notes: "" })
  assert.deepEqual([A.name, A.defaultRate, A.status], ["Vendor A", 45, "ACTIVE"], "1. created; spaces tidied")
  await assert.rejects(api.adblueVendors.create({ name: "vendor a", defaultRate: null }), /Vendor A already exists/, "no duplicate (case / spaces ignored)")
  await assert.rejects(api.adblueVendors.create({ name: " ", defaultRate: null }), /Enter the vendor name/)
  await assert.rejects(api.adblueVendors.create({ name: "Zero Rate", defaultRate: -1 }), /greater than 0/)
  const B = await api.adblueVendors.create({ name: "Vendor B", defaultRate: 48 })
  const C = await api.adblueVendors.create({ name: "Vendor C", defaultRate: null })
  await assert.rejects(api.adblueVendors.update(B.id, { name: "VENDOR A", defaultRate: 48 }), /already exists/, "a rename can't duplicate")
  assert.deepEqual((await api.audit.history(A.id)).map((e) => [e.action, e.module, e.recordType]), [["CREATED", "AdBlue", "AdBlue vendor"]])

  const buy = (vendor: { id: string } | null, date: string, buckets: number, litresPerBucket: number, pricePerBucket: number, extra: object = {}) =>
    api.adbluePurchases.create({ date, adblueVendorId: vendor?.id ?? null, product: "AdBlue", buckets, litresPerBucket, pricePerBucket, invoiceNo: "", notes: "", ...extra })
  // 2–4. An existing vendor picked; the actual rate (₹45 / L, then ₹48 / L) is the purchase's, whatever the default.
  const a1 = await buy(A, "2026-11-01", 5, 20, 900) // 100 L @ ₹45
  const a2 = await buy(A, "2026-11-03", 10, 20, 960) // 200 L @ ₹48 — above A's ₹45 default
  const b1 = await buy(B, "2026-11-02", 25, 20, 920) // 500 L @ ₹46
  assert.deepEqual([a1.adblueVendorId, a1.vendorName, a1.totalLitres, a1.totalCost], [A.id, "Vendor A", 100, 4500], "5. the batch belongs to Vendor A")
  assert.deepEqual([a2.totalCost / a2.totalLitres, b1.adblueVendorId], [48, B.id])
  // Changing the default never rewrites a purchase; renaming the vendor keeps the name a purchase was saved under.
  await api.adblueVendors.update(A.id, { name: "Vendor A Chemicals", defaultRate: 50, contactPerson: "Ravi", phone: "98450 11111", notes: "" })
  const a1Now = (await api.adbluePurchases.list()).find((p) => p.id === a1.id)!
  assert.deepEqual([a1Now.totalCost, a1Now.pricePerBucket, a1Now.vendorName], [4500, 900, "Vendor A"], "historical rate and name unchanged")
  // An older caller naming the vendor finds it (no duplicate); an unknown name creates it, audited.
  const byName = await api.adbluePurchases.create({ date: "2026-11-02", vendorName: "vendor b", product: "AdBlue", buckets: 1, litresPerBucket: 10, pricePerBucket: 460, invoiceNo: "", notes: "" })
  assert.equal(byName.adblueVendorId, B.id, "a name resolves to the existing vendor")
  const vendorsBefore = (await api.adblueVendors.list()).length
  const d1 = await api.adbluePurchases.create({ date: "2026-11-02", vendorName: "Vendor D", product: "AdBlue", buckets: 1, litresPerBucket: 20, pricePerBucket: 900, invoiceNo: "", notes: "" })
  assert.equal((await api.adblueVendors.list()).length, vendorsBefore + 1, "an unknown name adds the vendor")
  await assert.rejects(api.adbluePurchases.create({ date: "2026-11-02", adblueVendorId: "adv_nope", product: "", buckets: 1, litresPerBucket: 1, pricePerBucket: 1, invoiceNo: "", notes: "" }), /AdBlue vendor adv_nope not found/)

  /* ---------------------------------------------------------------- 6–12. vehicle draws name their vendor; FIFO; attribution */
  const tankerVehicles = new Set(readCollection("tankers").map((x) => x.vehicleId))
  const assignments = await api.assignments.list()
  const vehicle = (await api.vehicles.list()).find((v) => v.status === "ACTIVE" && v.fuelType === "DIESEL" && !tankerVehicles.has(v.id) && assignments.some((a) => a.vehicleId === v.id && a.customerId && a.startDate <= "2026-10-01" && a.endDate === null))!
  assert.ok(vehicle, "a diesel vehicle assigned since before October")
  writeCollection("adblue_entries", readCollection("adblue_entries").filter((e) => e.vehicleId !== vehicle.id))
  // Odometer readings rise with the date (and with each entry on a day), so a back-dated entry fits its neighbours.
  let seq = 0
  const odo = (date: string) => 200_000 + Math.round((Date.parse(date) - Date.parse("2026-10-01")) / 86_400_000) * 1000 + ++seq
  const draw = (vendor: { id: string } | null, date: string, quantityLitres: number) =>
    api.adblue.create({ vehicleId: vehicle.id, customerId: vehicle.assignedCustomerId, date, closingKm: odo(date), quantityLitres, invoiceNo: "", notes: "", source: "STOCK", adblueVendorId: vendor?.id ?? null })
  const entry = async (id: string) => (await api.adblue.list()).find((e) => e.id === id)!

  await assert.rejects(draw(null, "2026-11-05", 10), /Not enough unattributed AdBlue stock \(no vendor\): 0L\. Choose the vendor whose stock is used/, "6. a new draw names its vendor")
  // 8–10. 150 L from Vendor A = 100 L × ₹45 (the older batch) + 50 L × ₹48 = ₹6,900; effective ₹46 / L.
  const r1 = await draw(A, "2026-11-05", 150)
  const v1 = await entry(r1.id)
  assert.deepEqual([v1.amount, v1.costRate, v1.sourceVendor, v1.adblueVendorId], [6900, 46, "Vendor A Chemicals", A.id], "FIFO across two batches; the vendor shown")
  // 7. A vendor's stock only: 151 L from A is refused although Vendor B holds 510 L.
  const countBefore = (await api.adblue.list()).length
  await assert.rejects(draw(A, "2026-11-06", 151), /Insufficient AdBlue stock from Vendor A Chemicals\. Available: 150L/)
  await assert.rejects(draw(C, "2026-11-06", 1), /Insufficient AdBlue stock from Vendor C\. Available: 0L/, "a vendor with no stock can't be drawn from")
  assert.equal((await api.adblue.list()).length, countBefore, "nothing saved")
  // A back-dated draw takes the oldest batch first (FIFO in date order), and the later draw is re-costed.
  const r0 = await draw(A, "2026-11-02", 40)
  assert.deepEqual([(await entry(r0.id)).amount, (await entry(r1.id)).amount], [1800, 60 * 45 + 90 * 48], "a back-dated draw takes the oldest batch; the later draw is re-costed")
  // 11. Vehicle history: every entry names its vendor, rate and cost.
  const mine = (await api.adblue.list()).filter((e) => e.vehicleId === vehicle.id)
  assert.ok(mine.every((e) => e.sourceVendor === "Vendor A Chemicals" && e.costRate !== null && e.amount > 0))
  // 12. Customer view: each entry under the customer the vehicle served that day, with its vendor and cost.
  const forCustomer = (await api.adblue.list()).filter((e) => e.customerId === vehicle.assignedCustomerId && e.vehicleId === vehicle.id)
  assert.deepEqual(forCustomer.map((e) => [e.sourceVendor, e.amount]).sort(), [["Vendor A Chemicals", 1800], ["Vendor A Chemicals", 7020]])
  // The audit label names the vendor's stock.
  assert.match((await api.audit.history(r1.id))[0].label, /from Vendor A Chemicals stock/)

  /* ---------------------------------------------------------------- 13. vendor ledger reconciles with the company's */
  const purchases = await api.adbluePurchases.list()
  const draws = stockDraws(await api.adblue.list())
  const inv = valueInventory(purchases, draws)
  const company = stockFor(inventoryLedger(purchases, draws))
  const keys = [...new Set([NO_VENDOR, ...purchases.map((p) => p.adblueVendorId || NO_VENDOR)])]
  const per = keys.map((k) => stockFor(vendorLedger(purchases, draws, k)))
  assert.equal(per.reduce((t, r) => t + r.closing, 0).toFixed(2), company.closing.toFixed(2), "Σ vendor closing stock = company stock")
  assert.equal(per.reduce((t, r) => t + r.consumedCost, 0).toFixed(2), company.consumedCost.toFixed(2), "Σ vendor consumption cost = company consumption cost")
  assert.deepEqual(inv.vendorStock.get(A.id), { litres: 110, value: 110 * 48 }, "Vendor A: 300 − 190 L left, all at ₹48")
  const aLedger = stockFor(vendorLedger(purchases, draws, A.id), ["2026-11"])
  assert.deepEqual([aLedger.opening, aLedger.purchased, aLedger.consumed, aLedger.closing, aLedger.purchasedCost], [0, 300, 190, 110, 14100], "Opening + Purchased − Consumed = Closing")

  /* ---------------------------------------------------------------- 14. edit and delete put the stock back */
  await api.adblue.update(r0.id, { vehicleId: vehicle.id, customerId: vehicle.assignedCustomerId, date: "2026-11-02", closingKm: (await entry(r0.id)).closingKm, quantityLitres: 40, invoiceNo: "", notes: "", source: "STOCK", adblueVendorId: B.id }, "Was Vendor B's stock")
  assert.deepEqual([(await entry(r0.id)).sourceVendor, (await entry(r0.id)).amount], ["Vendor B", 40 * 46], "moved to Vendor B's batch")
  assert.equal(valueInventory(await api.adbluePurchases.list(), stockDraws(await api.adblue.list())).vendorStock.get(A.id)?.litres, 150, "Vendor A gets its 40 L back")
  assert.equal((await entry(r1.id)).amount, 6900, "…and the later draw is costed as before")
  await api.adblue.remove(r1.id, "Entered twice")
  assert.equal(valueInventory(await api.adbluePurchases.list(), stockDraws(await api.adblue.list())).vendorStock.get(A.id)?.litres, 300, "a delete returns the litres to their vendor")
  await assert.rejects(api.adbluePurchases.remove(b1.id, "Wrong vendor"), /Insufficient AdBlue stock from Vendor B/, "a batch already drawn from can't be deleted")
  // Restore / Push Back keeps the vendor and draws its stock again.
  const del = (await api.audit.history(r1.id)).find((e) => e.action === "DELETED")!
  await api.audit.restoreDeleted(del.id, "Deleted by mistake")
  const back = await entry(r1.id)
  assert.deepEqual([back.adblueVendorId, back.amount, back.sourceVendor], [A.id, 6900, "Vendor A Chemicals"], "restored with its vendor")
  assert.ok(!("sourceVendor" in readCollection("adblue_entries").find((e) => e.id === r1.id)!), "view fields are never stored")

  /* ---------------------------------------------------------------- 15. direct purchases never touch bulk stock */
  const stockBefore = valueInventory(await api.adbluePurchases.list(), stockDraws(await api.adblue.list())).stockLitres
  const direct = await api.adblue.create({ vehicleId: vehicle.id, customerId: vehicle.assignedCustomerId, date: "2026-11-08", closingKm: odo("2026-11-08"), quantityLitres: 20, invoiceNo: "R-9", notes: "", source: "DIRECT", adblueVendorId: C.id, vendorName: "ignored", rate: 95.5, paymentMode: "CASH" })
  assert.deepEqual([direct.adblueVendorId, direct.vendorName, direct.amount], [C.id, "Vendor C", 1910], "picked from the master; litres × its own rate")
  assert.equal(valueInventory(await api.adbluePurchases.list(), stockDraws(await api.adblue.list())).stockLitres, stockBefore, "bulk stock unchanged")
  assert.deepEqual([(await entry(direct.id)).sourceVendor, (await entry(direct.id)).costRate], ["Vendor C", 95.5])

  /* ---------------------------------------------------------------- archive / restore (never deleted) */
  await api.adblueVendors.archive(C.id)
  await assert.rejects(buy(C, "2026-11-09", 1, 20, 900), /Vendor C is archived/, "an archived vendor takes no new purchase")
  await api.adblueVendors.archive(A.id)
  const fromArchived = await draw(A, "2026-11-09", 10)
  assert.equal((await entry(fromArchived.id)).sourceVendor, "Vendor A Chemicals", "its stock can still be drawn")
  await api.adblueVendors.restore(A.id)
  await api.adblueVendors.restore(C.id)
  assert.deepEqual((await api.audit.history(C.id)).map((e) => e.action), ["CREATED", "ARCHIVED", "RESTORED"])
  assert.ok(!("remove" in api.adblueVendors), "vendors have no delete")

  /* ---------------------------------------------------------------- 16. records saved before vendor tracking */
  const legacyDraw = { id: "adb_legacy", createdAt: "2026-10-20T04:30:00.000Z", updatedAt: "2026-10-20T04:30:00.000Z", source: "STOCK" as const, vehicleId: vehicle.id, customerId: vehicle.assignedCustomerId, vendorId: "", date: "2026-10-25", closingKm: odo("2026-10-25"), quantityLitres: 5, amount: 0, invoiceNo: "", notes: "Before vendor tracking" }
  const legacyBuy = { id: "adp_legacy", createdAt: "2026-10-20T04:30:00.000Z", updatedAt: "2026-10-20T04:30:00.000Z", date: "2026-10-24", vendorName: " vendor   b ", product: "AdBlue", buckets: 1, litresPerBucket: 10, totalLitres: 10, pricePerBucket: 480, totalCost: 480, invoiceNo: "", notes: "" }
  writeCollection("adblue_entries", [...readCollection("adblue_entries"), legacyDraw])
  writeCollection("adblue_purchases", [...readCollection("adblue_purchases"), legacyBuy])
  const eventsBefore = readAuditEvents().length
  migrateStorage(true)
  const linked = readCollection("adblue_purchases").find((p) => p.id === "adp_legacy")!
  assert.deepEqual([linked.adblueVendorId, linked.vendorName, linked.totalLitres, linked.totalCost, linked.date], [B.id, " vendor   b ", 10, 480, "2026-10-24"], "the purchase is linked to its vendor; nothing else changes")
  assert.equal(readAuditEvents().length, eventsBefore + 1, "one SYSTEM event for the link")
  migrateStorage(true)
  assert.equal(readAuditEvents().length, eventsBefore + 1, "idempotent")
  const legacy = await entry("adb_legacy")
  assert.deepEqual([legacy.adblueVendorId ?? null, legacy.sourceVendor], [null, "No vendor (before vendor tracking)"], "an old draw is never given a vendor")
  assert.equal(readCollection("adblue_entries").find((e) => e.id === "adb_legacy")!.beforeVendorTracking, true, "an entry older than vendor tracking is marked so")
  assert.ok(readCollection("adblue_entries").filter((e) => e.id !== "adb_legacy").every((e) => e.beforeVendorTracking === false), "every entry the API saved carries false")
  // On 25 Oct only Vendor B's 10 L were on hand, so the history settles where the 5 L came from: ₹48 / L from B.
  assert.equal(legacy.amount, 240, "…and takes the only stock on hand then")
  await api.adblue.update(legacy.id, { vehicleId: vehicle.id, customerId: legacy.customerId, date: legacy.date, closingKm: legacy.closingKm, quantityLitres: 6, invoiceNo: "", notes: legacy.notes, source: "STOCK" }, "Litres corrected")
  assert.equal((await entry(legacy.id)).adblueVendorId ?? null, null, "editing it keeps it without a vendor")
  assert.equal(readCollection("adblue_entries").find((e) => e.id === "adb_legacy")!.beforeVendorTracking, true, "…and keeps its mark")
  const forged = await api.adblue.create({ vehicleId: vehicle.id, customerId: vehicle.assignedCustomerId, date: "2026-11-10", closingKm: odo("2026-11-10"), quantityLitres: 1, invoiceNo: "", notes: "", source: "STOCK", adblueVendorId: A.id, beforeVendorTracking: true } as never)
  assert.equal(readCollection("adblue_entries").find((e) => e.id === forged.id)!.beforeVendorTracking, false, "the mark is never taken from a request")
  await api.adblue.remove(forged.id, "Test entry")

  /* ---------------------------------------------------------------- 17. month lock and permissions */
  setRole("EMPLOYEE")
  await assert.rejects(api.adblue.create({ vehicleId: vehicle.id, customerId: vehicle.assignedCustomerId, date: "2026-10-30", closingKm: 150_000, quantityLitres: 1, invoiceNo: "", notes: "", source: "STOCK", adblueVendorId: A.id }), /October 2026 is locked/)
  await assert.rejects(buy(A, "2026-10-30", 1, 20, 900), /October 2026 is locked/)
  const e1 = await api.adblueVendors.create({ name: "Employee Vendor", defaultRate: 44 })
  assert.equal((await api.audit.history(e1.id))[0].actor.role, "EMPLOYEE", "the Employee manages vendors")
  await assert.rejects(api.adblue.remove(fromArchived.id, "Employee attempt"), /can't delete AdBlue records/, "the Employee deletes nothing")
  for (const role of ["ADBLUE", "TATA_ADBLUE"] as const) {
    setRole(role)
    await assert.rejects(api.adblueVendors.create({ name: "Profile Vendor", defaultRate: null }), /can't change the AdBlue vendor list/)
    await assert.rejects(api.adblueVendors.archive(B.id), /can't change the AdBlue vendor list/)
    assert.ok((await api.adblueVendors.list()).length > 0, `${role} reads the vendor list`)
  }

  /* ---------------------------------------------------------------- 18. two draws at once never overdraw a vendor */
  setRole("OWNER")
  const left = valueInventory(await api.adbluePurchases.list(), stockDraws(await api.adblue.list())).vendorStock.get(d1.adblueVendorId!)!.litres
  assert.equal(left, 20)
  const results = await Promise.allSettled([draw({ id: d1.adblueVendorId! }, "2026-11-10", 15), draw({ id: d1.adblueVendorId! }, "2026-11-10", 15)])
  assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"], "serialised: the second sees the first")
  assert.match(String((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason), /Insufficient AdBlue stock from Vendor D\. Available: 5L/)
  assert.ok([...valueInventory(await api.adbluePurchases.list(), stockDraws(await api.adblue.list())).vendorStock.values()].every((s) => s.litres >= 0), "no vendor below zero")

  console.log("AdBlue vendors: master, attribution, FIFO costing, vendor ledger, edits / deletes / restore, direct purchases, history, month lock, permissions and concurrency: all checks passed")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
