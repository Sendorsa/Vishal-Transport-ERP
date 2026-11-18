/**
 * Runnable check of AdBlue supplier credit and payments (owner, 18 Nov 2026), on the real API and an in-memory
 * localStorage:  npm run check:adblue-payments
 *
 *   1–3   bulk purchase on credit / partly paid / fully paid (with GST) — stock up once, whatever is paid
 *   4–7   instalments; one payment over several purchases; advance (explicit only); applying advance to a later purchase
 *   8–12  TDS 0.1 %, custom %, rounding; Credit with an amount or TDS refused; a "Credit" payment refused
 *   13    vendor account = purchases − settled = outstanding − advance; the ledger closes at it
 *   14–16 permanent delete restores what is owed (TDS too); the audit event keeps the payment; a failed audit deletes nothing
 *   17–18 stock, Inventory Value and FIFO costs unchanged by payments (GST never enters stock value)
 *   19–21 Employee / Owner / Dev / AdBlue profiles; month lock; purchases recorded before payments existed stay outstanding
 */
import assert from "node:assert/strict"
import { failure, setRole } from "./test-browser"
import type { AdBluePurchaseInput } from "./index"

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
  const { valueInventory, stockDraws } = await import("@/domain/adblue-inventory")
  const { purchaseValue, purchasePay, paidByPurchase, vendorAccounts, vendorLedger, tdsSplit, allocationStatus, unallocated, settledOf, supplierTotals } = await import("@/domain/adblue-payments")
  const { profileCall } = await import("@/lib/server/erp/profiles")
  const { readCollection, writeCollection } = await import("@/lib/storage/local-store")
  setRole("OWNER")

  const V = await api.adblueVendors.create({ name: "Payments Vendor", defaultRate: 50 })
  const W = await api.adblueVendors.create({ name: "Other Vendor", defaultRate: null })
  // 21. A purchase recorded before payments existed (no GST field): it stays outstanding at its Total Cost; nothing invented.
  const legacy = await api.adbluePurchases.create({ date: "2026-11-01", adblueVendorId: V.id, product: "AdBlue", buckets: 5, litresPerBucket: 20, pricePerBucket: 1000, invoiceNo: "OLD-1", notes: "" })
  writeCollection("adblue_purchases", readCollection("adblue_purchases").map((p) => (p.id === legacy.id ? (({ gstRate: _g, ...rest }) => (void _g, rest))(p) : p)))
  const pays = () => api.adbluePayments.list()
  const purchases = () => api.adbluePurchases.list()
  const payOf = async (id: string) => {
    const p = (await purchases()).find((x) => x.id === id)!
    return purchasePay(purchaseValue(p), paidByPurchase(await pays()).get(id) ?? 0)
  }
  const acct = async (vendorId = V.id) => vendorAccounts(await purchases(), await pays()).find((a) => a.vendorId === vendorId)!
  assert.deepEqual(await payOf(legacy.id), { value: 5000, paid: 0, outstanding: 5000, status: "UNPAID" }, "21. an old purchase: value = Total Cost, fully outstanding, no payment invented")
  assert.equal((await pays()).length, 0)
  const stockOf = async () => {
    const v = valueInventory(await purchases(), stockDraws(await api.adblue.list()))
    return { litres: v.stockLitres, value: v.stockValue, costs: JSON.stringify([...v.costOf].sort()) }
  }
  const buy = (vendor: { id: string }, date: string, buckets: number, pricePerBucket: number, extra: object = {}) =>
    api.adbluePurchases.create({ date, adblueVendorId: vendor.id, product: "AdBlue", buckets, litresPerBucket: 20, pricePerBucket, invoiceNo: `INV-${date.slice(8)}-${buckets}`, notes: "", ...extra })
  const pay = (amount: number, utr: string, allocations: { purchaseId: string; amount: number }[], x: Record<string, unknown> = {}) =>
    api.adbluePayments.create({ date: "2026-11-09", vendorId: V.id, amount, mode: "NEFT", utr, allocations, ...x })

  /* ---------------------------------------------------------------- 1–3. purchases and their payment details */
  const s0 = await stockOf()
  const p1 = await buy(V, "2026-11-02", 50, 1000) // 1,000 L, ₹50,000 — Credit
  assert.deepEqual([(await stockOf()).litres - s0.litres, await payOf(p1.id), (await pays()).length], [1000, { value: 50000, paid: 0, outstanding: 50000, status: "UNPAID" }, 0], "1. credit: stock +1,000 L, ₹50,000 owed, no payment")
  await assert.rejects(buy(V, "2026-11-02", 1, 100, { payment: { type: "CREDIT", amount: 100 } }), /Payment Type is Credit/, "11. Credit with an amount refused")
  await assert.rejects(buy(V, "2026-11-02", 1, 100, { payment: { type: "CREDIT", tdsPercent: 0.1 } }), /no TDS to deduct/, "12. Credit with TDS refused")
  const p2 = await buy(V, "2026-11-03", 50, 1000, { payment: { type: "PARTIAL", amount: 20000, mode: "UPI", utr: "UPI-P2", date: "2026-11-03" } })
  assert.deepEqual(await payOf(p2.id), { value: 50000, paid: 20000, outstanding: 30000, status: "PARTIAL" }, "2. partly paid: ₹30,000 outstanding")
  assert.equal(p2.totalLitres, 1000, "…stock is the purchase's litres, whatever was paid")
  await assert.rejects(buy(V, "2026-11-03", 1, 100, { payment: { type: "PARTIAL", amount: 100, mode: "UPI", utr: "X" } }), /less than the purchase value/)
  await assert.rejects(buy(V, "2026-11-03", 1, 100, { payment: { type: "PARTIAL", amount: 50, mode: "NEFT", utr: " " } }), /Enter the UTR/, "a transfer needs its UTR")
  await assert.rejects(buy(V, "2026-11-03", 1, 100, { payment: { type: "PARTIAL", amount: 50, mode: "Cheque", utr: "" } }), /cheque number/)
  await assert.rejects(buy(V, "2026-11-03", 1, 100, { payment: { type: "PARTIAL", amount: 50, mode: "Cash", utr: "" } }), /receipt number/)
  const p3 = await buy(V, "2026-11-04", 10, 900, { gstRate: 18, payment: { type: "FULL", amount: 10620, mode: "Cheque", utr: "CHQ-000117" } })
  assert.deepEqual([p3.totalCost, purchaseValue(p3), await payOf(p3.id)], [9000, 10620, { value: 10620, paid: 10620, outstanding: 0, status: "PAID" }], "3. fully paid incl. 18% GST: taxable ₹9,000 + ₹1,620 GST")
  await assert.rejects(buy(V, "2026-11-04", 1, 100, { payment: { type: "FULL", amount: 99, mode: "Cash", utr: "R-1" } }), /Fully Paid settles the whole purchase value/)
  await assert.rejects(buy(V, "2026-11-04", 1, 100, { gstRate: 101 }), /GST %/)
  const ev3 = (await api.audit.history((await pays()).find((p) => p.allocations[0].purchaseId === p3.id)!.id)).at(-1)!
  assert.deepEqual([ev3.action, /Paid with Bill INV-04-10/.test(ev3.note ?? "")], ["PAYMENT_RECORDED", true], "the purchase's payment is audited with it")

  /* ---------------------------------------------------------------- 4–7. instalments, several purchases, advance */
  const i1 = await pay(20000, "NEFT-I1", [{ purchaseId: p1.id, amount: 20000 }])
  assert.equal((await payOf(p1.id)).outstanding, 30000, "4. after ₹20,000: ₹30,000 left")
  await pay(15000, "NEFT-I2", [{ purchaseId: p1.id, amount: 15000 }])
  await pay(15000, "NEFT-I3", [{ purchaseId: p1.id, amount: 15000 }])
  assert.deepEqual(await payOf(p1.id), { value: 50000, paid: 50000, outstanding: 0, status: "PAID" }, "…after the third instalment: paid")
  await assert.rejects(pay(1, "NEFT-X", [{ purchaseId: p1.id, amount: 1 }]), /more than its outstanding ₹0.00/, "never beyond what a purchase owes")
  await assert.rejects(pay(100, "neft-i1", [], { acceptAdvance: true }), /Reference neft-i1 is already recorded/, "one reference, one payment (spaces / case ignored)")
  const p4 = await buy(V, "2026-11-05", 4, 1000) // ₹4,000
  const p5 = await buy(V, "2026-11-05", 6, 1000) // ₹6,000
  const multi = await pay(9000, "RTGS-M", [{ purchaseId: p4.id, amount: 4000 }, { purchaseId: p5.id, amount: 5000 }], { mode: "RTGS" })
  assert.deepEqual([(await payOf(p4.id)).status, (await payOf(p5.id)).outstanding, allocationStatus(multi)], ["PAID", 1000, "FULL"], "5. one payment over two purchases")
  await assert.rejects(pay(5000, "IMPS-A", [], { mode: "IMPS" }), /isn't allocated to any purchase/, "6. advance only when accepted")
  const adv = await pay(5000, "IMPS-A", [], { mode: "IMPS", acceptAdvance: true })
  assert.deepEqual([unallocated(adv), allocationStatus(adv), (await acct()).advance], [5000, "ADVANCE", 5000], "6. ₹5,000 advance credit")
  await assert.rejects(pay(100, "OTHER-V", [{ purchaseId: (await buy(W, "2026-11-05", 1, 100)).id, amount: 100 }]), /isn't a purchase from this vendor/)
  const p6 = await buy(V, "2026-11-08", 3, 1000) // a later purchase: ₹3,000
  const applied = await api.adbluePayments.allocate(adv.id, [{ purchaseId: p6.id, amount: 3000 }])
  assert.deepEqual([(await payOf(p6.id)).status, unallocated(applied), applied.allocations.length], ["PAID", 2000, 1], "7. advance applied to the later purchase; ₹2,000 left")
  await assert.rejects(api.adbluePayments.allocate(adv.id, [{ purchaseId: p5.id, amount: 2500 }]), /more than its outstanding|more than the advance left/)

  /* ---------------------------------------------------------------- 8–12. TDS */
  const p7 = await buy(V, "2026-11-06", 50, 1000) // ₹50,000
  const t1 = await pay(50000, "NEFT-TDS", [{ purchaseId: p7.id, amount: 50000 }], { tdsPercent: 0.1 })
  assert.deepEqual([t1.amount, t1.tdsAmount, t1.tdsRate, settledOf(t1), (await payOf(p7.id)).status], [49950, 50, 0.1, 50000, "PAID"], "8. ₹50,000 settled at 0.1%: ₹49,950 paid + ₹50 TDS; the purchase is paid in full")
  const p8 = await buy(V, "2026-11-06", 10, 1000)
  const t2 = await pay(10000, "NEFT-TDS2", [{ purchaseId: p8.id, amount: 10000 }], { tdsPercent: 2 })
  assert.deepEqual([t2.amount, t2.tdsAmount], [9800, 200], "9. a custom 2%")
  assert.deepEqual(tdsSplit(12345.67, 0.1), { settled: 12345.67, tds: 12.35, paid: 12333.32 }, "10. rounding to the paisa (12.34567 → 12.35)")
  await assert.rejects(pay(100, "T-BAD", [], { acceptAdvance: true, tdsPercent: 100 }), /TDS can't be the whole payment/)
  await assert.rejects(pay(100, "C-1", [], { acceptAdvance: true, mode: "Credit" }), /Credit means nothing is paid now/, "12. a Credit payment refused")

  /* ---------------------------------------------------------------- 13. reconciliation */
  const a = await acct()
  const ledger = vendorLedger(await purchases(), await pays(), V.id)
  assert.equal(a.balance, Math.round((a.purchased - a.settled) * 100) / 100, "13. balance = purchases − settled")
  assert.equal(a.balance, Math.round((a.outstanding - a.advance) * 100) / 100, "…= outstanding − advance")
  assert.equal(ledger.at(-1)!.balance, a.balance, "…and the ledger closes at it")
  assert.equal(a.tds, 250, "TDS counted once (₹50 + ₹200), inside settled")
  assert.equal(Math.round((a.cashPaid + a.tds) * 100) / 100, a.settled, "settled = cash paid + TDS")
  const tot = supplierTotals(vendorAccounts(await purchases(), await pays()))
  assert.ok(tot.outstanding >= a.outstanding && tot.advance >= a.advance, "the page totals cover every vendor (never netted across vendors)")

  /* ---------------------------------------------------------------- 17–18. stock untouched by payments */
  const s1 = await stockOf()
  await pay(1000, "IMPS-S", [{ purchaseId: p5.id, amount: 1000 }], { mode: "IMPS" })
  assert.deepEqual(await stockOf(), s1, "17. a payment never changes stock litres, value or any draw's cost")
  assert.equal(s1.value - s0.value > 0 && (s1.value - s0.value) % 1 === 0, true)
  const p3Batch = valueInventory(await purchases(), []).vendorStock.get(V.id)!
  assert.equal(p3Batch.value, (await purchases()).filter((p) => p.adblueVendorId === V.id).reduce((t, p) => t + p.totalCost, 0), "18. stock value = Σ Total Cost (taxable) — GST never enters FIFO cost")

  /* ---------------------------------------------------------------- purchase edits and deletes keep payments whole */
  await assert.rejects(api.adbluePurchases.update(p2.id, { date: "2026-11-03", adblueVendorId: V.id, product: "AdBlue", buckets: 10, litresPerBucket: 20, pricePerBucket: 1000, invoiceNo: "INV-03-50", notes: "" }, "Fewer"), /₹20,000.00 has already been paid against this purchase/, "a purchase's value never goes below what was paid")
  await assert.rejects(api.adbluePurchases.update(p2.id, { date: "2026-11-03", adblueVendorId: W.id, product: "AdBlue", buckets: 50, litresPerBucket: 20, pricePerBucket: 1000, invoiceNo: "INV-03-50", notes: "" }, "Other vendor"), /vendor can't be changed/)
  await assert.rejects(api.adbluePurchases.remove(p2.id, "Duplicate"), /Payments are allocated to this purchase/, "a purchase with payments isn't deleted")

  /* ---------------------------------------------------------------- Edit Purchase → change its payment type (owner, 18 Nov 2026) */
  {
    const asIs = async (id: string) => (await purchases()).find((x) => x.id === id)!
    const body = (x: { date: string; buckets: number; pricePerBucket: number; invoiceNo: string; gstRate?: number; notes?: string }, payment?: NonNullable<AdBluePurchaseInput["payment"]>) => ({ date: x.date, adblueVendorId: V.id, product: "AdBlue", buckets: x.buckets, litresPerBucket: 20, pricePerBucket: x.pricePerBucket, invoiceNo: x.invoiceNo, notes: x.notes ?? "", gstRate: x.gstRate ?? 0, ...(payment ? { payment } : {}) })
    const k1 = await buy(V, "2026-11-07", 50, 1000) // ₹50,000 on credit
    const k1Before = await asIs(k1.id)
    const stockBefore = await stockOf()
    const accBefore = await acct()
    const nPays = (await pays()).length
    // 6. Missing / invalid reference: refused, nothing saved.
    await assert.rejects(api.adbluePurchases.update(k1.id, body(k1, { type: "FULL", amount: 50000, mode: "NEFT", utr: " ", date: "2026-11-09" })), /Enter the UTR/)
    await assert.rejects(api.adbluePurchases.update(k1.id, body(k1, { type: "FULL", amount: 50000, mode: "Cheque", utr: "", date: "2026-11-09" })), /cheque number/)
    await assert.rejects(api.adbluePurchases.update(k1.id, body(k1, { type: "FULL", amount: 50000, mode: "NEFT", utr: "NEFT-I1", date: "2026-11-09" })), /Reference NEFT-I1 is already recorded/, "a reference already used is refused")
    await assert.rejects(api.adbluePurchases.update(k1.id, body(k1, { type: "FULL", amount: 40000, mode: "NEFT", utr: "NEFT-K1", date: "2026-11-09" })), /Fully Paid settles the outstanding amount \(₹50,000.00\)/)
    await assert.rejects(api.adbluePurchases.update(k1.id, body(k1, { type: "FULL", amount: 55000, mode: "NEFT", utr: "NEFT-K1", date: "2026-11-09" })), /more than this purchase owes/, "more than owed only as explicit advance")
    await assert.rejects(api.adbluePurchases.update(k1.id, body(k1, { type: "PARTIAL", amount: 50000, mode: "NEFT", utr: "NEFT-K1", date: "2026-11-09" })), /less than the outstanding amount/)
    await assert.rejects(api.adbluePurchases.update(k1.id, body(k1, { type: "CREDIT", amount: 10 })), /Payment Type is Credit/)
    await assert.rejects(api.adbluePurchases.update(k1.id, body(k1, { type: "FULL", amount: 50000, mode: "NEFT", utr: "NEFT-K1", date: "2026-11-06" })), /dated before the purchase/)
    assert.equal((await pays()).length, nPays, "…nothing saved by a refused edit")
    // 1. Credit → Fully Paid (NEFT): a payment and its allocation; the purchase itself — the stock batch — untouched.
    await api.adbluePurchases.update(k1.id, body(k1, { type: "FULL", amount: 50000, mode: "NEFT", utr: "NEFT-K1", date: "2026-11-09" }))
    const accAfter = await acct()
    const k1Pay = (await pays()).find((x) => x.allocations.some((a) => a.purchaseId === k1.id))!
    assert.deepEqual([(await payOf(k1.id)).outstanding, accAfter.settled - accBefore.settled, accBefore.outstanding - accAfter.outstanding, k1Pay.amount, k1Pay.mode, k1Pay.utr], [0, 50000, 50000, 50000, "NEFT", "NEFT-K1"], "1. Credit → Fully Paid: outstanding ₹0; vendor paid +₹50,000, outstanding −₹50,000")
    assert.deepEqual(await asIs(k1.id), k1Before, "the purchase record is unchanged (not even updatedAt)")
    assert.deepEqual((await api.audit.history(k1.id)).map((e) => e.action), ["CREATED"], "…and has no UPDATED event: only the payment was recorded")
    assert.equal((await api.audit.history(k1Pay.id))[0].action, "PAYMENT_RECORDED")
    assert.ok(vendorLedger(await purchases(), await pays(), V.id).some((r) => r.id === k1Pay.id && r.credit === 50000), "7. in the vendor ledger")
    assert.ok((await pays()).some((x) => x.id === k1Pay.id), "…and in the central payments list")
    assert.deepEqual(await stockOf(), stockBefore, "8. stock litres, value and every FIFO cost unchanged")
    // Saving the same form again creates no duplicate: nothing is owed any more.
    await assert.rejects(api.adbluePurchases.update(k1.id, body(k1, { type: "FULL", amount: 50000, mode: "NEFT", utr: "NEFT-K1b", date: "2026-11-09" })), /already fully paid/)
    assert.equal((await pays()).filter((x) => x.allocations.some((a) => a.purchaseId === k1.id)).length, 1, "no duplicate payment")
    // 2. Credit → Partially Paid ₹20,000 (₹30,000 left), then 3. Partially → Fully Paid with the ₹30,000 at 0.1% TDS (5).
    const k2 = await buy(V, "2026-11-07", 50, 1000, { invoiceNo: "INV-K2" })
    await api.adbluePurchases.update(k2.id, body(k2, { type: "PARTIAL", amount: 20000, mode: "UPI", utr: "UPI-K2", date: "2026-11-08" }))
    assert.deepEqual(await payOf(k2.id), { value: 50000, paid: 20000, outstanding: 30000, status: "PARTIAL" }, "2. Credit → Partially Paid: a ₹20,000 payment, ₹30,000 still owed")
    const first = (await pays()).find((x) => x.utr === "UPI-K2")!
    await api.adbluePurchases.update(k2.id, body({ ...k2, notes: "Checked against the bill" }, { type: "FULL", amount: 30000, mode: "NEFT", utr: "NEFT-K2", date: "2026-11-09", tdsPercent: 0.1 }), "Note added")
    const second = (await pays()).find((x) => x.utr === "NEFT-K2")!
    assert.deepEqual([await payOf(k2.id), second.amount, second.tdsAmount, settledOf(second)], [{ value: 50000, paid: 50000, outstanding: 0, status: "PAID" }, 29970, 30, 30000], "3 / 5. the remaining ₹30,000 settled by a second payment, ₹29,970 + ₹30 TDS")
    assert.deepEqual((await pays()).find((x) => x.id === first.id), first, "4. the first payment is untouched")
    assert.equal((await asIs(k2.id)).notes, "Checked against the bill", "a detail change and a payment saved together")
    assert.deepEqual((await api.audit.history(k2.id)).map((e) => [e.action, e.reason ?? null]), [["CREATED", null], ["UPDATED", "Note added"]])
    // 4. Editing details of a paid purchase keeps every payment exactly as it was.
    const paysBefore = JSON.stringify(await pays())
    await api.adbluePurchases.update(k2.id, body({ ...k2, notes: "Bill filed" }), "Filing")
    assert.equal(JSON.stringify(await pays()), paysBefore, "4. payments unchanged by a purchase edit")
    // A Fully Paid conversion with more than owed, accepted as advance.
    const k3 = await buy(V, "2026-11-07", 1, 1000, { invoiceNo: "INV-K3" })
    await api.adbluePurchases.update(k3.id, body(k3, { type: "FULL", amount: 1500, mode: "Cash", utr: "R-K3", date: "2026-11-09", acceptAdvance: true }))
    const k3Pay = (await pays()).find((x) => x.utr === "R-K3")!
    assert.deepEqual([(await payOf(k3.id)).status, k3Pay.allocations[0].amount, unallocated(k3Pay)], ["PAID", 1000, 500], "the extra ₹500 is advance credit, explicitly")
    // Atomic: a failed audit write saves neither the detail change nor the payment.
    const k4 = await buy(V, "2026-11-07", 1, 1000, { invoiceNo: "INV-K4" })
    const k4Before = await asIs(k4.id)
    failure.key = "vt:auditEvents"
    failure.once = true
    await assert.rejects(api.adbluePurchases.update(k4.id, body({ ...k4, notes: "x" }, { type: "FULL", amount: 1000, mode: "Cash", utr: "R-K4", date: "2026-11-09" }), "x y z"), /simulated storage failure/)
    assert.deepEqual([await asIs(k4.id), (await pays()).some((x) => x.utr === "R-K4")], [k4Before, false], "nothing saved")
    // 7. Reconciliation after all of it.
    const r = await acct()
    assert.equal(vendorLedger(await purchases(), await pays(), V.id).at(-1)!.balance, r.balance)
    assert.equal(r.balance, Math.round((r.outstanding - r.advance) * 100) / 100)
    // Month lock: the Employee can't settle an October purchase from its edit.
    const octP = await buy(V, "2026-10-20", 1, 1000, { invoiceNo: "INV-OCT" })
    setRole("EMPLOYEE")
    await assert.rejects(api.adbluePurchases.update(octP.id, body(octP, { type: "FULL", amount: 1000, mode: "Cash", utr: "R-OCT", date: "2026-11-09" })), /October 2026 is locked/)
    setRole("OWNER")
  }

  /* ---------------------------------------------------------------- edit */
  const e1 = await api.adbluePayments.update(i1.id, { date: "2026-11-09", amount: 20000, mode: "NEFT", utr: "NEFT-I1", notes: "Checked" })
  assert.deepEqual([e1.notes, e1.allocations], ["Checked", i1.allocations], "notes alone: no reason; allocations kept as recorded")
  await assert.rejects(api.adbluePayments.update(i1.id, { date: "2026-11-09", amount: 18000, mode: "NEFT", utr: "NEFT-I1" }), /allocations \(₹20000.00\) are more than the payment/, "never silently re-allocated")
  await assert.rejects(api.adbluePayments.update(i1.id, { date: "2026-11-09", amount: 18000, mode: "NEFT", utr: "NEFT-I1", allocations: [{ purchaseId: p1.id, amount: 18000 }] }), /Enter the reason for changing the amount, allocations/)
  await api.adbluePayments.update(i1.id, { date: "2026-11-09", amount: 18000, mode: "NEFT", utr: "NEFT-I1", allocations: [{ purchaseId: p1.id, amount: 18000 }] }, "Bank statement says ₹18,000")
  assert.equal((await payOf(p1.id)).outstanding, 2000, "an explicit re-allocation: the purchase owes ₹2,000 again")
  await assert.rejects(api.adbluePayments.update(i1.id, { date: "2026-11-09", amount: 18000, mode: "NEFT", utr: "NEFT-I1", vendorId: W.id }), /vendor can't be changed/)

  /* ---------------------------------------------------------------- 14–16. permanent delete */
  const before = await acct()
  failure.key = "vt:auditEvents"
  failure.once = true
  await assert.rejects(api.adbluePayments.remove(t1.id, "Bank returned it"), /simulated storage failure/)
  assert.ok((await pays()).some((p) => p.id === t1.id), "a failed audit write deletes nothing")
  const t1Before = (await pays()).find((p) => p.id === t1.id)!
  await assert.rejects(api.adbluePayments.remove(t1.id, " "), /reason/)
  await api.adbluePayments.remove(t1.id, "Bank returned it")
  const after = await acct()
  assert.deepEqual([(await pays()).some((p) => p.id === t1.id), readCollection("adblue_payments").some((p) => p.id === t1.id)], [false, false], "14. gone — no voided copy")
  assert.deepEqual([(await payOf(p7.id)).outstanding, before.settled - after.settled, before.cashPaid - after.cashPaid, before.tds - after.tds, after.outstanding - before.outstanding], [50000, 50000, 49950, 50, 50000], "15. ₹50,000 owed again; its ₹49,950 + ₹50 TDS leave every total")
  const del = (await api.audit.history(t1.id)).at(-1)!
  assert.deepEqual([del.action, del.reason, del.recordType, del.before], ["DELETED", "Bank returned it", "AdBlue payment", JSON.parse(JSON.stringify(t1Before))], "16. the audit event keeps the whole payment (allocations, TDS)")
  assert.equal(del.actor.role, "OWNER")
  assert.equal(await api.adbluePayments.remove(t1.id, "again"), undefined, "a repeated delete finds nothing")
  assert.equal((await api.audit.history(t1.id)).filter((e) => e.action === "DELETED").length, 1, "…and records nothing")
  assert.equal(vendorLedger(await purchases(), await pays(), V.id).some((r) => r.id === t1.id), false, "not in the ledger")
  const restore = await api.audit.checkRestore(del.id)
  assert.ok(!restore.ok, "permanent: never pushed back from the audit log")
  const reused = await pay(50000, "NEFT-TDS", [{ purchaseId: p7.id, amount: 50000 }], { tdsPercent: 0.1 })
  assert.equal((await payOf(p7.id)).status, "PAID", "its reference is free again")

  /* ---------------------------------------------------------------- 19–20. roles and month lock */
  const oct = await buy(V, "2026-10-20", 1, 1000) // the Owner may enter a locked month
  setRole("EMPLOYEE")
  const ep = await pay(500, "EMP-1", [{ purchaseId: p5.id, amount: 0 }], { acceptAdvance: true })
  await api.adbluePayments.update(ep.id, { date: "2026-11-09", amount: 600, mode: "NEFT", utr: "EMP-1", acceptAdvance: true }, "Typo")
  await assert.rejects(api.adbluePayments.remove(ep.id, "Mine"), /Only the Owner and Dev can delete/, "19. the Employee records and edits, never deletes")
  await assert.rejects(pay(10, "EMP-OCT", [], { date: "2026-10-31", acceptAdvance: true }), /October 2026 is locked/, "20. no payment dated in a locked month")
  await assert.rejects(api.adbluePayments.allocate(ep.id, [{ purchaseId: oct.id, amount: 100 }]), /October 2026 is locked/, "…nor settling a locked month's purchase")
  await assert.rejects(api.adbluePayments.remove(reused.id, "x y z"), /Only the Owner and Dev/)
  setRole("DEV")
  await api.adbluePayments.allocate(ep.id, [{ purchaseId: oct.id, amount: 100 }])
  await api.adbluePayments.remove(ep.id, "Dev clean-up")
  assert.equal((await pays()).some((p) => p.id === ep.id), false, "Dev deletes")
  for (const role of ["TATA_ADBLUE", "ADBLUE"] as const) {
    setRole(role)
    await assert.rejects(pays(), /can't see AdBlue supplier payments/, `${role}: no supplier payments`)
    await assert.rejects(pay(1, "AB-1", [], { acceptAdvance: true }), /can't record AdBlue supplier payments/)
    for (const m of ["adbluePayments.list", "adbluePayments.create", "adbluePayments.update", "adbluePayments.allocate", "adbluePayments.remove"]) assert.equal(profileCall(role, m, async () => 1), null, `${role}: ${m} is off the method list`)
    if (role === "ADBLUE") {
      const credit = await buy(V, "2026-11-09", 1, 1000)
      assert.ok(credit.id, "the Adblue profile still adds a bulk purchase (credit)")
      await assert.rejects(buy(V, "2026-11-09", 1, 1000, { payment: { type: "FULL", amount: 1000, mode: "Cash", utr: "R-AB" } }), /can't record AdBlue supplier payments/, "…but never with a payment")
    }
  }
  setRole("OWNER")
  assert.deepEqual(await payOf(legacy.id), { value: 5000, paid: 0, outstanding: 5000, status: "UNPAID" }, "21. the old purchase is untouched throughout")

  /* ---------------------------------------------------------------- Make Payment workflow: oldest first, vendor advance (owner, 18 Nov 2026) */
  {
    const { allocateOldestFirst } = await import("@/domain/adblue-payments")
    assert.deepEqual(allocateOldestFirst(12000, [{ id: "a", left: 8000 }, { id: "locked", left: 500, locked: true }, { id: "b", left: 6550 }, { id: "c", left: 100 }]), { a: 8000, b: 4000 }, "4. oldest first, each up to what it owes, locked ones skipped")
    assert.deepEqual(allocateOldestFirst(20000, [{ id: "a", left: 8000 }, { id: "b", left: 6550 }]), { a: 8000, b: 6550 }, "…the rest stays unallocated (advance, only if confirmed)")
    const X = await api.adblueVendors.create({ name: "Advance Vendor", defaultRate: 40 })
    const xb = (date: string, buckets: number, invoiceNo: string) => api.adbluePurchases.create({ date, adblueVendorId: X.id, product: "AdBlue", buckets, litresPerBucket: 20, pricePerBucket: 800, invoiceNo, notes: "" })
    const xp = (amount: number, utr: string, date: string, allocations: { purchaseId: string; amount: number }[] = []) => api.adbluePayments.create({ date, vendorId: X.id, amount, mode: "NEFT", utr, allocations, acceptAdvance: true })
    const octAdv = await xp(3000, "X-OCT", "2026-10-25") // advance recorded in October (locked for the Employee)
    const x1 = await xb("2026-11-02", 5, "X-1") // ₹4,000
    const x2 = await xb("2026-11-03", 10, "X-2") // ₹8,000
    const novAdv = await xp(5000, "X-NOV", "2026-11-04")
    const xAcc = async () => vendorAccounts(await purchases(), await pays()).find((a) => a.vendorId === X.id)!
    const before = await xAcc()
    const nPays = (await pays()).length
    const sBefore = await stockOf()
    assert.deepEqual([before.outstanding, before.advance, before.balance], [12000, 8000, 4000])
    await assert.rejects(api.adbluePayments.applyAdvance(X.id, [{ purchaseId: x1.id, amount: 9000 }]), /more than its outstanding/, "never beyond what a purchase owes")
    await assert.rejects(api.adbluePayments.applyAdvance(X.id, [{ purchaseId: x1.id, amount: 4000 }, { purchaseId: x2.id, amount: 5000 }]), /more than the advance credit available \(₹8000.00\)/, "never beyond the advance")
    // 13. Permissions; 12. month lock: the Employee can't use the October advance.
    setRole("ADBLUE")
    await assert.rejects(api.adbluePayments.applyAdvance(X.id, [{ purchaseId: x1.id, amount: 100 }]), /can't edit AdBlue supplier payments/)
    assert.equal(profileCall("ADBLUE", "adbluePayments.applyAdvance", async () => 1), null, "off the AdBlue profiles' method list")
    setRole("EMPLOYEE")
    await assert.rejects(api.adbluePayments.applyAdvance(X.id, [{ purchaseId: x1.id, amount: 4000 }, { purchaseId: x2.id, amount: 3000 }]), /more than the advance credit available \(₹5000.00\)/, "12. the Employee only has November's ₹5,000 (October is locked)")
    // 6. Applying existing advance across purchases (Employee, November's payment): no new payment, allocations added.
    const used = await api.adbluePayments.applyAdvance(X.id, [{ purchaseId: x1.id, amount: 4000 }, { purchaseId: x2.id, amount: 1000 }])
    setRole("OWNER")
    const after = await xAcc()
    assert.deepEqual([used.map((p) => p.id), (await pays()).length], [[novAdv.id], nPays], "6. no new payment record: November's payment gained the allocations")
    assert.deepEqual([after.outstanding, after.advance, after.balance, after.settled], [7000, 3000, 4000, before.settled], "outstanding and advance both fall by ₹5,000; net payable and settled unchanged")
    assert.deepEqual([(await payOf(x1.id)).status, (await payOf(x2.id)).outstanding], ["PAID", 7000])
    // The Owner applies the rest — October's advance — across one purchase.
    await api.adbluePayments.applyAdvance(X.id, [{ purchaseId: x2.id, amount: 3000 }])
    const octNow = (await pays()).find((p) => p.id === octAdv.id)!
    assert.deepEqual([octNow.allocations, unallocated(octNow), (await xAcc()).advance], [[{ purchaseId: x2.id, amount: 3000 }], 0, 0], "oldest advance used; nothing left")
    assert.deepEqual((await api.audit.history(novAdv.id)).map((e) => e.action), ["PAYMENT_RECORDED", "UPDATED"], "audited on the payment it came from")
    const xl = vendorLedger(await purchases(), await pays(), X.id)
    assert.equal(xl.at(-1)!.balance, (await xAcc()).balance, "10. the ledger closes at the vendor balance (applying advance moves no money)")
    assert.deepEqual(await stockOf(), sBefore, "11. stock and FIFO untouched")
    await assert.rejects(api.adbluePayments.applyAdvance(X.id, [{ purchaseId: x2.id, amount: 1 }]), /no advance credit to apply|more than the advance credit available \(₹0.00\)/)
  }

  console.log("AdBlue supplier payments: credit / partly / fully paid purchases (GST), instalments, several purchases, advance and applying it, TDS (0.1 %, custom, rounding), Credit refused, reconciliation, edits, permanent delete (audit kept, atomic), stock and FIFO untouched, roles, month lock, historical purchases, Edit Purchase → Credit / Partially / Fully Paid (new payments only, purchase untouched), allocate oldest first, vendor advance applied without a new payment: all checks passed")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
