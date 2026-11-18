/**
 * Runnable check for Tyre Data → Tyre (owner, 17 Nov 2026):  npm run check:tyre
 * The real API on in-memory demo data, clock fixed at 10 Nov 2026, 10:00 IST (October closed for the Employee).
 *
 *   1. Masters: the starting repair types; suppliers / repair types / brands / sizes added once (spaces and case
 *      ignored, archived included), renamed, archived and restored — never deleted; audited.
 *   2. Invoice with one line and with several: base = quantity × rate, CGST + SGST (odd paise) or IGST, line total,
 *      KM run, invoice totals; the company from the vehicle's assignment on the date, the vehicle type from the master.
 *   3. Validation: no customer on the date, archived vehicle / supplier, future date, no lines, bad numbers — nothing
 *      saved, no event; a failed storage write (the audit log) saves nothing (atomic).
 *   4. Edit: change, add and remove lines (kept lines keep their ids), move the date (company follows); archived
 *      values already on the invoice stay usable.
 *   5. Month lock, permissions (Employee: no delete; AdBlue profiles: nothing), delete with a reason, restore.
 *   6. Filters: header and line fields, combined (e.g. Wheel Alignment for one customer's buses in October), search.
 *   7. Monthly Sheet: one row per saved line, invoices counted once, company / Office / repair-type / supplier totals,
 *      line-level filters, GST; an edit (amount, date → another month) shows in the sheet at once.
 *   9. Vendor payments: Credit (no payment), full / partial with the invoice (one transaction), instalments, one payment
 *      over several invoices, advance (only explicit) applied to a later invoice, UTR required for every type but
 *      Credit, totals / ledger reconciled, invoice edits never rewrite payments, permanent delete (Owner / Dev), month lock, audit.
 *  10. "Deduct TDS?" (off, 0.1%, 1%, custom, 0%, paise, invalid, Credit refused) — settled once, cash = paid only;
 *      corrections (reason, allocations only when sent, never re-allocated, recalculated invoices / vendor / advance),
 *      permanent delete (allocations, TDS, advance and balances reversed; audit kept), Employee vs Owner / Dev, month lock,
 *      audit, history unchanged.
 *   8. Tyre page = the current India month: earlier invoices excluded but kept (Monthly Sheet); the clock moved across
 *      30 Nov → 1 Dec at 00:00 IST (empty new month, zero totals, nothing deleted), 31 Dec → 1 Jan, 31 Mar → 1 Apr (the
 *      sheet's calendar / financial years and months); a date edit moving an invoice between months.
 */
import assert from "node:assert/strict"
import { failure, loadCheckDemoData, setRole } from "./test-browser"
import type { TyreInvoiceInput, TyreItemInput } from "./index"

let NOW = new Date("2026-11-10T04:30:00.000Z").getTime() // moved forward in section 8 (month / year / FY changes)
const RealDate = Date
class FixedDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length) super(...(args as [string]))
    else super(NOW)
  }
  static now() {
    return NOW
  }
}
const setClock = (iso: string) => void (NOW = new RealDate(iso).getTime())
globalThis.Date = FixedDate as DateConstructor

async function main() {
  const { api } = await import("./index")
  const { todayISO } = await import("@/lib/format")
  const { attributionSplit, companyKey, currentMonthInvoices, DEFAULT_REPAIR_TYPES, monthLines, pickSheetMonth, sheetMonths, sheetTotals, sheetYears, spendBy, financialChanges, invoiceMatches, kmRun, lineAmounts, NO_FILTERS, OFFICE_FILTER, OFFICE_LABEL, sameBill, tyreTotals } = await import("@/domain/tyre")
  const { profileCall } = await import("@/lib/server/erp/profiles")
  const { readCollection } = await import("@/lib/storage/local-store")
  type View = Parameters<typeof invoiceMatches>[0]
  assert.equal(todayISO(), "2026-11-10")
  loadCheckDemoData()
  setRole("OWNER")
  const events = async () => (await api.audit.list()).length

  /* ---------------------------------------------------------------- 1. masters */
  const masters = async () => api.tyreMasters.list()
  const repairTypes = (await masters()).filter((m) => m.kind === "REPAIR_TYPE").map((m) => m.name)
  assert.deepEqual(repairTypes, [...DEFAULT_REPAIR_TYPES], "the 2026–27 register's repair types are there to start with")
  const rt = async (name: string) => (await masters()).find((m) => m.kind === "REPAIR_TYPE" && m.name === name)!.id
  const [ALIGN, NEWTYRE, FITTING] = [await rt("Wheel Alignment"), await rt("New Tyre Purchased"), await rt("Tyre Fitting")]
  const sup = await api.tyreMasters.create({ kind: "SUPPLIER", name: "  Bhagyalakshmi   Tyres " })
  assert.equal(sup.name, "Bhagyalakshmi Tyres", "spaces cleaned")
  await assert.rejects(api.tyreMasters.create({ kind: "SUPPLIER", name: "BHAGYALAKSHMI tyres" }), /Bhagyalakshmi Tyres already exists/, "no duplicate supplier (case / spaces ignored)")
  const sup2 = await api.tyreMasters.create({ kind: "SUPPLIER", name: "MRE Treads" })
  const apollo = await api.tyreMasters.create({ kind: "BRAND", name: "Apollo" })
  const mrf = await api.tyreMasters.create({ kind: "BRAND", name: "MRF" })
  const size = await api.tyreMasters.create({ kind: "SIZE", name: "235/75 R17.5" })
  const newType = await api.tyreMasters.create({ kind: "REPAIR_TYPE", name: "Nitrogen Filling" })
  assert.equal((await masters()).filter((m) => m.kind === "REPAIR_TYPE").length, DEFAULT_REPAIR_TYPES.length + 1, "a new repair type joins the list")
  await assert.rejects(api.tyreMasters.create({ kind: "REPAIR_TYPE", name: "wheel  alignment" }), /Wheel Alignment already exists/)
  await assert.rejects(api.tyreMasters.create({ kind: "BRAND", name: "   " }), /Enter the tyre brand name/)
  await api.tyreMasters.create({ kind: "SIZE", name: "Apollo" }) // the same text in another list is a different value
  const renamed = await api.tyreMasters.update(sup2.id, { name: "MRE Treads Hosur" })
  assert.equal(renamed.name, "MRE Treads Hosur")
  await api.tyreMasters.archive(mrf.id)
  await assert.rejects(api.tyreMasters.create({ kind: "BRAND", name: "mrf" }), /MRF already exists \(archived\) — restore it instead/)
  assert.ok(!("remove" in api.tyreMasters), "masters are never deleted")
  const masterEvents = (await api.audit.history(sup2.id)).map((e) => e.action)
  assert.deepEqual(masterEvents, ["CREATED", "UPDATED"], "masters are audited")

  /* ---------------------------------------------------------------- 2. invoices: amounts, company, vehicle type */
  const assignments = await api.assignments.list()
  const settings = await api.settings.get()
  const customersAll = (await api.customers.list()).filter((c) => c.status === "ACTIVE")
  const assigned = (await api.vehicles.list()).filter((v) => v.status === "ACTIVE" && assignments.some((a) => a.vehicleId === v.id && a.customerId && a.startDate <= "2026-09-01" && a.endDate === null))
  const [vA, vB] = [assigned[0], assigned.find((v) => assignments.find((a) => a.vehicleId === v.id && a.endDate === null)!.customerId !== assignments.find((a) => a.vehicleId === assigned[0].id && a.endDate === null)!.customerId)!]
  const custOf = (vehicleId: string) => assignments.find((a) => a.vehicleId === vehicleId && a.endDate === null)!.customerId!
  const line = (repairTypeId: string, quantity: number, rate: number, extra: Partial<TyreItemInput> = {}): TyreItemInput => ({ repairTypeId, quantity, rate, gstRate: 18, taxType: "CGST_SGST", ...extra })
  const inv = (vehicleId: string, date: string, items: TyreItemInput[], extra: Partial<TyreInvoiceInput> = {}): TyreInvoiceInput => ({ date, vehicleId, supplierId: sup.id, billNo: "", items, ...extra })

  const one = await api.tyreInvoices.create(inv(vA.id, "2026-11-05", [line(ALIGN, 4, 400)], { billNo: "37" }))
  assert.equal(one.customerId, custOf(vA.id), "company = the vehicle's customer on the invoice date")
  assert.deepEqual([one.items[0].baseValue, one.items[0].cgst, one.items[0].sgst, one.items[0].igst, one.items[0].totalValue], [1600, 144, 144, 0, 1888], "4 × ₹400 = ₹1,600 + 9% + 9%")
  // The spec's example invoice: 2 new tyres, 4 alignments, 2 fittings.
  const many = await api.tyreInvoices.create(
    inv(vA.id, "2026-11-06", [line(NEWTYRE, 2, 14650, { brandId: apollo.id, sizeId: size.id, tyreNumber: "B0426 / B0427", openingKm: 73636, closingKm: 84210 }), line(ALIGN, 4, 400), line(FITTING, 2, 200)], { billNo: "003/26-27", paymentMode: "UPI", purchaseMode: "Credit", paymentDetails: "UTR 1234", remarks: "Front axle", payment: { amount: 10000, utr: "UTR1234", date: "2026-11-06" } })
  )
  const t = tyreTotals(many.items)
  assert.deepEqual([t.baseValue, t.cgst, t.sgst, t.igst, t.grandTotal, t.lines], [31300, 2817, 2817, 0, 36934, 3], "₹29,300 + ₹1,600 + ₹400 = ₹31,300; 18% GST = ₹5,634; grand total ₹36,934")
  assert.equal(kmRun(many.items[0]), 10574, "KM run = closing − opening")
  // Odd paise: GST ₹0.27 splits ₹0.14 CGST + ₹0.13 SGST (as calculateTax), and IGST takes it whole.
  assert.deepEqual(lineAmounts(1, 1.5, 18, "CGST_SGST"), { baseValue: 1.5, cgst: 0.14, sgst: 0.13, igst: 0, totalValue: 1.77 })
  assert.deepEqual(lineAmounts(3, 333.33, 18, "IGST"), { baseValue: 999.99, cgst: 0, sgst: 0, igst: 180, totalValue: 1179.99 })
  assert.deepEqual(lineAmounts(0.3, 0.1, 0, "CGST_SGST").baseValue, 0.03, "no floating-point noise")
  const igst = await api.tyreInvoices.create(inv(vB.id, "2026-11-07", [line(ALIGN, 1, 1000, { taxType: "IGST" })], { supplierId: sup2.id }))
  assert.deepEqual([igst.items[0].igst, igst.items[0].cgst, igst.items[0].totalValue], [180, 0, 1180])
  assert.equal(igst.customerId, custOf(vB.id))
  const typeName = settings.vehicleTypes.find((x) => x.code === vA.typeCode)?.name
  assert.ok(typeName, "the vehicle type comes from the vehicle master (the register shows its name)")

  /* ---------------------------------------------------------------- 3. validation and atomic failure */
  const before = [JSON.stringify(readCollection("tyre_invoices")), await events()]
  const unchanged = async () => assert.deepEqual([JSON.stringify(readCollection("tyre_invoices")), await events()], before, "nothing saved, no event")
  const { id: _i, createdAt: _c, updatedAt: _u, statusHistory: _s, ...tpl } = vA
  void [_i, _c, _u, _s]
  const spare = await api.vehicles.create({ ...tpl, regNo: "TN70TY0001", assignedCustomerId: null, odometerKm: 1000, defaultDriverId: null } as never)
  const before2 = [JSON.stringify(readCollection("tyre_invoices")), await events()]
  before[0] = before2[0]
  before[1] = before2[1]
  await assert.rejects(api.tyreInvoices.create(inv(spare.id, "2026-11-08", [line(ALIGN, 1, 100)])), /TN70TY0001 has no customer assignment on 08-11-2026.*or record it explicitly as Office \/ No Customer/, "no customer on the date: refused unless chosen explicitly — never a silent default")
  await assert.rejects(api.tyreInvoices.create(inv(vA.id, "2026-11-08", [line(ALIGN, 1, 100)], { office: true })), /is assigned to .* so the invoice belongs to .* can't be recorded as Office \/ No Customer/, "a vehicle with a customer is never Office / No Customer")
  await assert.rejects(api.tyreInvoices.create(inv(vA.id, "2026-11-11", [line(ALIGN, 1, 100)])), /future/)
  await assert.rejects(api.tyreInvoices.create(inv(vA.id, "2026-11-08", [])), /at least one repair line/)
  await assert.rejects(api.tyreInvoices.create(inv(vA.id, "2026-11-08", [line(ALIGN, 0, 100)])), /Line 1: Quantity must be greater than 0/)
  await assert.rejects(api.tyreInvoices.create(inv(vA.id, "2026-11-08", [line(ALIGN, 1, 100), line(ALIGN, 1, -5)])), /Line 2: Enter the rate/)
  await assert.rejects(api.tyreInvoices.create(inv(vA.id, "2026-11-08", [line(ALIGN, 1, 10.555)])), /up to 2 decimals/)
  await assert.rejects(api.tyreInvoices.create(inv(vA.id, "2026-11-08", [line(ALIGN, 1, 10, { openingKm: 500, closingKm: 400 })])), /Closing KM can't be less than opening KM/)
  await assert.rejects(api.tyreInvoices.create(inv(vA.id, "2026-11-08", [line(ALIGN, 1, 10, { brandId: mrf.id })])), /MRF is archived/, "an archived brand takes no new line")
  await assert.rejects(api.tyreInvoices.create(inv(vA.id, "2026-11-08", [line(apollo.id, 1, 10)])), /Repair type .* not found/, "a value from the wrong list is refused")
  await assert.rejects(api.tyreInvoices.create(inv(vA.id, "2026-11-08", [line(ALIGN, 1, 10)], { supplierId: "" })), /Choose the supplier/)
  failure.key = "vt:auditEvents"
  failure.once = true
  await assert.rejects(api.tyreInvoices.create(inv(vA.id, "2026-11-08", [line(ALIGN, 1, 100), line(FITTING, 2, 50)])), /simulated storage failure/)
  await unchanged()

  /* ---------------------------------------------------------------- 3b. Office / No Customer (explicit), duplicate bills */
  const office = await api.tyreInvoices.create(inv(spare.id, "2026-11-08", [line(FITTING, 2, 250)], { office: true, billNo: "37" }))
  assert.deepEqual([office.office, office.customerId], [true, null], "recorded explicitly: no customer, no customer record created")
  assert.ok(!(await api.customers.list()).some((c) => /office/i.test(c.name)), "no fake customer in the customer master")
  const splitNow = attributionSplit(await api.tyreInvoices.list())
  assert.equal(round(splitNow.customers + splitNow.office), tyreTotals((await api.tyreInvoices.list()).flatMap((x) => x.items)).grandTotal, "customers + office = total tyre spend")
  assert.equal(splitNow.office, 590, "office spend: 2 × ₹250 + 18%")
  // Bill "37" from the same supplier exists (invoice `one`): a warning in the form, never a block — it was saved.
  assert.ok(sameBill(office, one) && sameBill({ supplierId: sup.id, billNo: " 3 7 " }, one), "same supplier + bill number (spaces / case ignored)")
  assert.ok(!sameBill({ supplierId: sup2.id, billNo: "37" }, one) && !sameBill({ supplierId: sup.id, billNo: "" }, { supplierId: sup.id, billNo: "" }), "another supplier, or no bill number: not a duplicate")

  /* ---------------------------------------------------------------- 4. edit */
  const kept = many.items[0].id
  await assert.rejects(api.tyreInvoices.update(many.id, inv(vA.id, "2026-11-06", [{ ...line(NEWTYRE, 2, 14500), id: kept }], { billNo: "003/26-27" })), /Enter the reason for changing the repair lines/, "a financial change needs a reason")
  await assert.rejects(api.tyreInvoices.update(many.id, inv(vA.id, "2026-11-04", many.items.map((i) => ({ ...i })), { billNo: "004" }), " a "), /reason for changing the invoice date, bill number/, "…naming what changed")
  await assert.rejects(api.tyreInvoices.update(one.id, inv(vA.id, "2026-11-05", one.items.map((i) => ({ ...i })), { billNo: "37", supplierId: sup2.id })), /supplier/)
  const noted = await api.tyreInvoices.update(one.id, inv(vA.id, "2026-11-05", one.items.map((i) => ({ ...i })), { billNo: "37", paymentMode: "Cash", paymentDetails: "Paid at the shop", remarks: "Front wheels" }))
  assert.equal(noted.paymentMode, "Cash", "payment notes and remarks alone need no reason")
  assert.deepEqual(financialChanges(one, { ...one, office: true }), ["attribution"])
  assert.deepEqual(financialChanges(one, { ...one, items: one.items.map((i) => ({ ...i, gstRate: 12 })) }), ["repair lines"], "GST is a line change")
  const edited = await api.tyreInvoices.update(
    many.id,
    { ...inv(vA.id, "2026-11-06", [{ ...line(NEWTYRE, 2, 14500, { brandId: apollo.id, sizeId: size.id }), id: kept }, line(newType.id, 4, 50)], { billNo: "003/26-27" }) },
    "Rate corrected; fitting was free"
  )
  assert.equal(edited.items[0].id, kept, "a kept line keeps its id")
  assert.equal(edited.items.length, 2, "lines removed and added")
  assert.equal(tyreTotals(edited.items).grandTotal, round(29000 * 1.18 + 200 * 1.18))
  const upd = (await api.audit.history(many.id)).at(-1)!
  assert.deepEqual([upd.action, upd.reason, (upd.before as { items: unknown[] }).items.length, (upd.after as { items: unknown[] }).items.length], ["UPDATED", "Rate corrected; fitting was free", 3, 2], "the edit is audited with every line before and after")
  // An archived value already on the invoice stays usable on an edit.
  await api.tyreMasters.archive(apollo.id)
  await api.tyreInvoices.update(many.id, inv(vA.id, "2026-11-06", edited.items.map((i) => ({ ...i })), { billNo: "003/26-27" }))
  await api.tyreMasters.restore(apollo.id)

  /* ---------------------------------------------------------------- 5. month lock, permissions, delete, restore */
  const october = await api.tyreInvoices.create(inv(vA.id, "2026-10-15", [line(ALIGN, 2, 500), line(NEWTYRE, 1, 9000, { brandId: apollo.id })], { billNo: "OCT-1" }))
  const octB = await api.tyreInvoices.create(inv(vB.id, "2026-10-20", [line(ALIGN, 1, 600)]))
  setRole("EMPLOYEE")
  await assert.rejects(api.tyreInvoices.create(inv(vA.id, "2026-10-16", [line(ALIGN, 1, 100)])), /October 2026 is locked/, "the Employee follows the month lock")
  await assert.rejects(api.tyreInvoices.update(october.id, inv(vA.id, "2026-10-15", [line(ALIGN, 1, 100)])), /October 2026 is locked/)
  await assert.rejects(api.tyreInvoices.update(one.id, inv(vA.id, "2026-10-30", [line(ALIGN, 1, 100)])), /October 2026 is locked/, "…on the new date too")
  const byEmployee = await api.tyreInvoices.create(inv(vA.id, "2026-11-09", [line(FITTING, 1, 200)]))
  await api.tyreInvoices.update(byEmployee.id, inv(vA.id, "2026-11-09", [line(FITTING, 2, 200)]), "Two fittings, not one")
  await api.tyreMasters.create({ kind: "BRAND", name: "JK" })
  await assert.rejects(api.tyreInvoices.remove(byEmployee.id, "Employee attempt"), /can't delete/, "the Employee deletes nothing")
  for (const role of ["TATA_ADBLUE", "ADBLUE"] as const) {
    setRole(role)
    await assert.rejects(api.tyreInvoices.create(inv(vA.id, "2026-11-09", [line(FITTING, 1, 200)])), /permission|can't/i, `${role}: no Tyre`)
    await assert.rejects(api.tyreMasters.create({ kind: "BRAND", name: "CEAT" }), /permission|can't/i)
    for (const m of ["tyreInvoices.list", "tyreInvoices.create", "tyreMasters.list"]) assert.equal(profileCall(role, m, async () => 1), null, `${role}: ${m} is off the method list`)
  }
  setRole("OWNER")
  await assert.rejects(api.tyreInvoices.remove(byEmployee.id, " "), /reason/, "a delete needs a reason")
  await api.tyreInvoices.remove(byEmployee.id, "Entered twice")
  assert.ok(!(await api.tyreInvoices.list()).some((x) => x.id === byEmployee.id))
  const del = (await api.audit.list()).find((e) => e.action === "DELETED" && e.recordId === byEmployee.id)!
  assert.deepEqual([del.module, del.recordType, del.reason], ["Tyre", "Tyre invoice", "Entered twice"])
  await api.audit.restoreDeleted(del.id, "Not a duplicate after all")
  const back = (await api.tyreInvoices.list()).find((x) => x.id === byEmployee.id)!
  assert.deepEqual([back.items.length, tyreTotals(back.items).grandTotal], [1, 472], "restored with its lines and amounts")
  setRole("DEV")
  await api.tyreInvoices.update(october.id, inv(vA.id, "2026-10-15", october.items.map((i) => ({ ...i })), { billNo: "OCT-1" }), "Dev in a locked month")

  /* ---------------------------------------------------------------- 6. filters */
  const all = await api.tyreInvoices.list()
  const vehicles = await api.vehicles.list()
  const toViews = (xs: typeof all): View[] =>
    xs.map((x) => {
      const v = vehicles.find((y) => y.id === x.vehicleId)!
      return { ...x, totals: tyreTotals(x.items), regNo: v.regNo, vehicleTypeCode: v.typeCode, vehicleType: v.typeCode, company: x.office ? OFFICE_LABEL : x.customerId!, supplier: x.supplierId === sup.id ? "Bhagyalakshmi Tyres" : "MRE Treads Hosur" }
    })
  const views = toViews(all)
  const match = (f: Partial<typeof NO_FILTERS>) => views.filter((v) => invoiceMatches(v, { ...NO_FILTERS, ...f })).map((v) => v.id).sort()
  const ids = (...xs: { id: string }[]) => xs.map((x) => x.id).sort()
  assert.deepEqual(match({ period: "2026-10" }), ids(october, octB), "month")
  assert.deepEqual(match({ period: "FY:2026" }), ids(...all), "financial year 2026–27")
  assert.deepEqual(match({ period: "RANGE", from: "2026-11-06", to: "2026-11-07" }), ids(many, igst), "date range (inclusive)")
  assert.deepEqual(match({ repairTypeId: ALIGN, customerId: custOf(vA.id), vehicleType: vA.typeCode, period: "2026-10" }), ids(october), "Wheel Alignment for one customer's vehicles of that type in October")
  assert.deepEqual(match({ brandId: apollo.id, repairTypeId: ALIGN }), [], "line filters match on the same line (Apollo is on the new-tyre line)")
  assert.deepEqual(match({ brandId: apollo.id }), ids(edited, october), "a line's brand finds its invoice")
  assert.deepEqual(match({ sizeId: size.id }), ids(edited), "a line's size")
  assert.deepEqual(match({ supplierId: sup2.id }), ids(igst))
  assert.deepEqual(match({ customerId: OFFICE_FILTER }), ids(office), "the Office / No Customer filter")
  assert.ok(!match({ customerId: custOf(vA.id) }).includes(office.id) && match({}).includes(office.id), "office spend: in the total, in no customer's")
  assert.deepEqual(match({ billNo: "003/26" }), ids(edited), "bill number")
  assert.deepEqual(match({ paymentMode: "UPI" }), [], "the edit cleared the payment mode (not sent)")
  assert.deepEqual(match({ search: vB.regNo.toLowerCase().replace(/\s/g, "") }), ids(igst, octB), "search: vehicle registration")
  assert.deepEqual(match({ search: "MRE" }), ids(igst), "search: supplier")
  assert.deepEqual(match({ vehicleId: vB.id, period: "2026-11" }), ids(igst))
  void customersAll

  /* ---------------------------------------------------------------- 7. Monthly Sheet */
  const sheet = (vs: View[], month: string, f: Partial<typeof NO_FILTERS> = {}) => monthLines(vs, month, { ...NO_FILTERS, ...f })
  const nov = sheet(views, "2026-11")
  const novInvoices = all.filter((x) => x.date.startsWith("2026-11"))
  assert.equal(nov.length, novInvoices.reduce((n, x) => n + x.items.length, 0), "one row per saved line of the month's invoices")
  assert.equal(new Set(nov.map((r) => r.item.id)).size, nov.length, "each line exactly once")
  const nt = sheetTotals(nov)
  assert.deepEqual([nt.invoices, nt.lines], [novInvoices.length, nov.length])
  assert.deepEqual(sheetTotals(nov.filter((r) => r.invoice.id === edited.id)).invoices, 1, "a two-line invoice: two rows, one invoice")
  assert.equal(nt.grandTotal, tyreTotals(novInvoices.flatMap((x) => x.items)).grandTotal, "expenditure = Σ the month's invoices")
  assert.equal(nt.gst, round(nt.cgst + nt.sgst + nt.igst))
  assert.equal(nt.grandTotal, round(nt.baseValue + nt.gst), "base + GST = expenditure")
  assert.ok(nt.igst === 180 && nt.cgst > 0, "IGST and CGST / SGST lines both present, kept apart")
  const byCompany = spendBy(nov, companyKey)
  const officeRow = byCompany.find((r) => r.key === OFFICE_FILTER)!
  assert.deepEqual([officeRow.label, officeRow.grandTotal, officeRow.invoices], [OFFICE_LABEL, 590, 1], "Office / No Customer: its own row")
  assert.equal(round(byCompany.reduce((n, r) => n + r.grandTotal, 0)), nt.grandTotal, "companies + Office = the month's expenditure")
  assert.ok(!byCompany.some((r) => r.key !== OFFICE_FILTER && r.key === ""), "no customer row without a customer")
  assert.equal(byCompany.find((r) => r.key === custOf(vB.id))!.grandTotal, 1180, "a customer's total: its own invoices only")
  const byRepair = spendBy(nov, (r) => [r.item.repairTypeId, r.item.repairTypeId])
  assert.equal(round(byRepair.reduce((n, r) => n + r.grandTotal, 0)), nt.grandTotal, "repair types add up to the month")
  // Line-level filter: only the matching lines (and their totals), not the whole invoice.
  const newTyreRows = sheet(views, "2026-11", { repairTypeId: NEWTYRE })
  assert.deepEqual(newTyreRows.map((r) => r.item.id), [kept], "repair-type filter: the line, not its invoice's other lines")
  assert.equal(sheetTotals(newTyreRows).grandTotal, 34220, "2 × ₹14,500 + 18%")
  assert.deepEqual(sheet(views, "2026-11", { supplierId: sup2.id }).map((r) => r.invoice.id), [igst.id], "supplier filter")
  assert.deepEqual(sheet(views, "2026-11", { customerId: OFFICE_FILTER }).map((r) => r.invoice.id), [office.id], "Office filter")
  assert.deepEqual(sheet(views, "2026-11", { search: "B0426" }), [], "search a tyre number: only lines carrying it (the edit cleared it)")
  assert.deepEqual(sheet(views, "2026-10").map((r) => r.invoice.id).sort(), ids(october, october, octB), "month switching: October's lines")
  assert.deepEqual(sheet(views, "2025-11"), [], "year switching: November 2025 is empty")
  // Edits show at once (the sheet is computed from the saved invoices): the amount, then the date into October.
  setRole("OWNER")
  const novBefore = sheetTotals(sheet(views, "2026-11")).grandTotal
  await api.tyreInvoices.update(one.id, inv(vA.id, "2026-11-05", [{ ...one.items[0], rate: 500 }], { billNo: "37" }), "Rate was ₹500")
  const v1 = toViews(await api.tyreInvoices.list())
  assert.equal(sheetTotals(sheet(v1, "2026-11")).grandTotal, round(novBefore - 1888 + 2360), "an edited amount changes the month at once")
  await api.tyreInvoices.update(one.id, inv(vA.id, "2026-10-25", [{ ...one.items[0], rate: 500 }], { billNo: "37" }), "Bill was dated October")
  const v2 = toViews(await api.tyreInvoices.list())
  assert.ok(!sheet(v2, "2026-11").some((r) => r.invoice.id === one.id) && sheet(v2, "2026-10").some((r) => r.invoice.id === one.id), "a changed date moves the invoice to its new month")
  assert.equal(sheetTotals(sheet(v2, "2026-11")).grandTotal, round(novBefore - 1888), "…and out of the old one")

  /* ---------------------------------------------------------------- 8. Tyre page = the current month; Monthly Sheet = history */
  const nowViews = async () => toViews(await api.tyreInvoices.list())
  const register = async (f: Partial<typeof NO_FILTERS> = {}) => currentMonthInvoices(await nowViews(), todayISO(), { ...NO_FILTERS, ...f })
  const stored = () => JSON.stringify(readCollection("tyre_invoices"))
  let vs = await nowViews()
  const nov10 = await register()
  assert.deepEqual(nov10.map((v) => v.id).sort(), vs.filter((v) => v.date.startsWith("2026-11")).map((v) => v.id).sort(), "10 Nov: the Tyre page lists November's invoices")
  assert.ok(nov10.length > 0 && ![october, octB, one].some((x) => nov10.some((v) => v.id === x.id)), "October invoices (incl. one moved there in 7) are not on the Tyre page…")
  assert.deepEqual(sheet(vs, "2026-10").map((r) => r.invoice.id).sort(), ids(october, october, octB, one), "…and are all in the Monthly Sheet for October")
  assert.equal(tyreTotals(nov10.flatMap((v) => v.items)).grandTotal, sheetTotals(sheet(vs, "2026-11")).grandTotal, "the Tyre page's total = the sheet's November total")
  assert.deepEqual((await register({ period: "2026-10" })).length, nov10.length, "a period saved by the old page is ignored: always the current month")
  assert.deepEqual((await register({ supplierId: sup2.id })).map((v) => v.id), [igst.id], "filters work inside the month")
  assert.deepEqual((await register({ customerId: OFFICE_FILTER })).map((v) => v.id), [office.id])
  // Month change, India time: 30 Nov 23:59 IST is still November; 00:00 IST on 1 Dec is December — whatever the device's zone.
  const beforeDec = stored()
  const novLines = sheet(vs, "2026-11").map((r) => r.item.id)
  const allIds = vs.map((v) => v.id)
  setClock("2026-11-30T18:29:00.000Z")
  assert.deepEqual([todayISO(), (await register()).length], ["2026-11-30", nov10.length], "30 Nov, 23:59 IST: still November")
  setClock("2026-11-30T18:30:00.000Z")
  assert.equal(todayISO(), "2026-12-01")
  const dec = await register()
  assert.deepEqual([dec.length, tyreTotals(dec.flatMap((v) => v.items)).grandTotal], [0, 0], "1 Dec, 00:00 IST: an empty new month, zero totals — automatically")
  assert.equal(stored(), beforeDec, "the month change deletes, archives or rewrites nothing")
  vs = await nowViews()
  assert.deepEqual(sheet(vs, "2026-11").map((r) => r.item.id), novLines, "November stays in the Monthly Sheet, line for line")
  assert.deepEqual(sheetMonths("calendar", 2026, todayISO()).at(-1), "2026-12", "the sheet offers December once it starts")
  // A December invoice (dated today by default in the form) and a date edit moving it back to November.
  const decInv = await api.tyreInvoices.create(inv(vA.id, todayISO(), [line(FITTING, 2, 300)], { billNo: "DEC-1" }))
  assert.deepEqual((await register()).map((v) => v.id), [decInv.id], "December's invoice on the Tyre page")
  await api.tyreInvoices.update(decInv.id, inv(vA.id, "2026-11-28", decInv.items.map((i) => ({ ...i })), { billNo: "DEC-1" }), "Bill was dated 28 November")
  vs = await nowViews()
  assert.deepEqual([(await register()).length, sheet(vs, "2026-11").some((r) => r.invoice.id === decInv.id)], [0, true], "an invoice whose date moves to November leaves the Tyre page and joins November's sheet")
  // 31 Dec → 1 Jan 2027: the page moves to January; the sheet keeps 2026 and offers 2027 (calendar) / FY 2026–27 to January.
  setClock("2026-12-31T18:29:59.000Z")
  assert.equal(todayISO(), "2026-12-31")
  setClock("2026-12-31T18:30:00.000Z")
  assert.equal(todayISO(), "2027-01-01")
  assert.deepEqual((await register()).length, 0, "1 Jan 2027: January, empty")
  const dates = (await nowViews()).map((v) => v.date)
  assert.deepEqual(sheetYears("calendar", dates, todayISO()), [2027, 2026], "calendar years: 2027 (current) and 2026 (data)")
  assert.deepEqual(sheetMonths("calendar", 2027, todayISO()), ["2027-01"], "no future month")
  assert.equal(sheetMonths("calendar", 2026, todayISO()).length, 12, "every month of 2026 still offered")
  assert.deepEqual(sheetYears("fy", dates, todayISO()), [2026], "January 2027 is still FY 2026–27")
  assert.deepEqual([sheetMonths("fy", 2026, todayISO())[0], sheetMonths("fy", 2026, todayISO()).at(-1), sheetMonths("fy", 2026, todayISO()).length], ["2026-04", "2027-01", 10], "FY 2026–27: April 2026 … January 2027")
  assert.equal(pickSheetMonth(sheetMonths("calendar", 2027, todayISO()), "2026-11"), "2027-01", "switching to 2027 from November: the latest month offered")
  assert.equal(pickSheetMonth(sheetMonths("calendar", 2026, todayISO()), "2027-01"), "2026-01", "…and back to 2026: the same month of the year")
  assert.deepEqual(sheet(await nowViews(), "2026-10").map((r) => r.invoice.id).sort(), ids(october, october, octB, one), "October 2026 still there in 2027")
  // 31 Mar → 1 Apr 2027: a new financial year.
  setClock("2027-03-31T18:30:00.000Z")
  assert.equal(todayISO(), "2027-04-01")
  assert.deepEqual(sheetYears("fy", dates, todayISO()), [2027, 2026], "1 Apr 2027: FY 2027–28 starts; FY 2026–27 kept")
  assert.deepEqual(sheetMonths("fy", 2027, todayISO()), ["2027-04"])
  assert.equal(pickSheetMonth(sheetMonths("fy", 2026, todayISO()), "2027-04"), "2026-04", "FY 2026–27 from April 2027: April 2026")
  assert.deepEqual((await register()).length, 0, "April 2027: empty")
  const left = new Set((await api.tyreInvoices.list()).map((x) => x.id))
  assert.ok(allIds.every((id) => left.has(id)), "after three month changes every earlier invoice is still stored")
  setClock("2026-11-10T04:30:00.000Z")

  /* ---------------------------------------------------------------- 9. vendor payments, allocations, advance, ledger */
  const { invoicePay, paidByInvoice, unallocated, vendorAccounts, vendorLedger } = await import("@/domain/tyre")
  setRole("OWNER")
  const ven = await api.tyreMasters.create({ kind: "SUPPLIER", name: "Ledger Tyres" })
  const vinv = (date: string, rate: number, extra: Partial<TyreInvoiceInput> = {}) => api.tyreInvoices.create(inv(vA.id, date, [line(ALIGN, 1, rate)], { supplierId: ven.id, ...extra }))
  const pays = () => api.tyrePayments.list()
  const payOf = async (id: string) => {
    const x = (await api.tyreInvoices.list()).find((i) => i.id === id)!
    return invoicePay(tyreTotals(x.items).grandTotal, paidByInvoice(await pays()).get(id) ?? 0)
  }
  const account = async () => vendorAccounts(await api.tyreInvoices.list(), await pays()).find((a) => a.supplierId === ven.id)!
  const pay = (amount: number, utr: string, allocations: { invoiceId: string; amount: number }[], extra: Record<string, unknown> = {}) => api.tyrePayments.create({ date: "2026-11-09", supplierId: ven.id, amount, mode: "NEFT", utr, allocations, ...extra })

  // 1. Credit, nothing paid: an outstanding invoice, no payment.
  const i1 = await vinv("2026-11-01", 1000, { paymentMode: "Credit", billNo: "L-1" }) // ₹1,180
  assert.deepEqual(await payOf(i1.id), { total: 1180, paid: 0, outstanding: 1180, status: "UNPAID" }, "Credit: unpaid, all outstanding")
  assert.equal((await pays()).filter((p) => p.supplierId === ven.id).length, 0, "Credit records no payment")
  // 2. Paid in full with the invoice: invoice and payment saved together.
  const i2 = await vinv("2026-11-02", 500, { paymentMode: "UPI", billNo: "L-2", payment: { amount: 590, utr: "UPI 0001", date: "2026-11-02" } })
  assert.deepEqual(await payOf(i2.id), { total: 590, paid: 590, outstanding: 0, status: "PAID" })
  const p2 = (await pays()).find((p) => p.allocations.some((a) => a.invoiceId === i2.id))!
  assert.deepEqual([p2.mode, p2.utr, p2.amount, p2.reference, p2.allocations], ["UPI", "UPI 0001", 590, "L-2", [{ invoiceId: i2.id, amount: 590 }]], "the payment: its mode, UTR and bill, allocated to the invoice")
  assert.deepEqual((await api.audit.history(p2.id)).map((e) => [e.action, e.recordType, e.note]), [["PAYMENT_RECORDED", "Tyre payment", "Paid with Bill L-2 (02-11-2026)"]], "the payment is audited on its own")

  // 8 / 9 / 10. UTR rules (form and API), amounts — refused with nothing saved.
  const state = async () => [JSON.stringify(readCollection("tyre_invoices")), JSON.stringify(readCollection("tyre_payments")), await events()]
  const s9 = await state()
  await assert.rejects(vinv("2026-11-03", 100, { paymentMode: "NEFT", payment: { amount: 100, utr: "   ", date: "2026-11-03" } }), /UTR \/ transaction reference number — it is required when the Payment Type is NEFT/, "a non-credit payment without a UTR is refused")
  await assert.rejects(vinv("2026-11-03", 100, { paymentMode: "Cash" }), /Enter the Amount Paid by Cash/, "a non-credit type needs the amount paid")
  await assert.rejects(vinv("2026-11-03", 100, { paymentMode: "Cash", payment: { amount: -5, utr: "X", date: "2026-11-03" } }), /can't be negative/)
  await assert.rejects(vinv("2026-11-03", 100, { paymentMode: "Credit", payment: { amount: 50, utr: "", date: "2026-11-03" } }), /Payment Type is Credit, so nothing is paid now/)
  await assert.rejects(vinv("2026-11-03", 100, { paymentMode: "Cash", payment: { amount: 200, utr: "R-1", date: "2026-11-03" } }), /more than the invoice total .* advance credit/, "more than the total only as explicit advance")
  await assert.rejects(vinv("2026-11-03", 100, { paymentMode: "UPI", payment: { amount: 118, utr: "upi0001", date: "2026-11-03" } }), /Reference upi0001 is already recorded/, "one UTR, one payment (spaces / case ignored)")
  await assert.rejects(vinv("2026-11-03", 100, { paymentMode: "Bank", payment: { amount: 118, utr: "B-1", date: "2026-11-03" } }), /Choose the Payment Type/)
  await assert.rejects(vinv("2026-11-03", 100, { paymentMode: "UPI", payment: { amount: 118, utr: "F-1", date: "2026-11-11" } }), /future/)
  await assert.rejects(pay(100, "", [], { acceptAdvance: true }), /UTR/, "the vendor page's payment needs a UTR too")
  await assert.rejects(pay(100, "C-1", [], { mode: "Credit", acceptAdvance: true }), /Credit means nothing is paid now/)
  await assert.rejects(pay(0, "Z-1", [], { acceptAdvance: true }), /more than ₹0/)
  failure.key = "vt:tyrePayments" // the payment's write fails after the invoice's: neither is saved
  failure.once = true
  await assert.rejects(vinv("2026-11-03", 100, { paymentMode: "UPI", payment: { amount: 118, utr: "ATOMIC-1", date: "2026-11-03" } }), /simulated storage failure/)
  assert.deepEqual(await state(), s9, "refused or failed: no invoice, no payment, no event")
  // 10. Credit without a UTR saves; a non-credit payment with its UTR saves (2 above).

  // 3. Partial payment with the invoice; 4. a second payment settles it.
  const i3 = await vinv("2026-11-03", 2000, { paymentMode: "Cash", billNo: "L-3", payment: { amount: 1000, utr: "CASH-RCPT-17", date: "2026-11-03" } }) // ₹2,360
  assert.deepEqual(await payOf(i3.id), { total: 2360, paid: 1000, outstanding: 1360, status: "PARTIAL" })
  await assert.rejects(pay(1361, "NEFT-5", [{ invoiceId: i3.id, amount: 1361 }]), /Bill L-3 \(03-11-2026\): ₹1361.00 is more than its outstanding ₹1360.00/, "never beyond what the invoice owes")
  await assert.rejects(pay(100, "NEFT-X", [{ invoiceId: one.id, amount: 100 }]), /isn't an invoice of this vendor/, "only this vendor's invoices")
  await assert.rejects(pay(100, "NEFT-Y", [{ invoiceId: i3.id, amount: 200 }]), /more than the payment/)
  await pay(1360, "NEFT-5", [{ invoiceId: i3.id, amount: 1360 }], { date: "2026-11-05" })
  assert.deepEqual(await payOf(i3.id), { total: 2360, paid: 2360, outstanding: 0, status: "PAID" }, "two instalments: paid")
  // 5. One payment, several invoices, explicit allocations.
  const i4 = await vinv("2026-11-04", 300, { billNo: "L-4" }) // ₹354
  const multi = await pay(1534, "RTGS-9", [{ invoiceId: i1.id, amount: 1180 }, { invoiceId: i4.id, amount: 354 }], { mode: "RTGS", date: "2026-11-06", companyCode: "VT", reference: "L-1, L-4" })
  assert.deepEqual([(await payOf(i1.id)).status, (await payOf(i4.id)).status, unallocated(multi)], ["PAID", "PAID", 0])
  // 6. Advance: only when said so.
  await assert.rejects(pay(5000, "CHQ-111", []), /₹5000.00 of this payment isn't allocated to any invoice/, "never silently unallocated")
  const adv = await pay(5000, "CHQ-111", [], { mode: "Cheque", date: "2026-11-07", acceptAdvance: true })
  assert.deepEqual([(await account()).advance, (await account()).balance], [5000, -5000], "advance credit shown, the vendor owes us")
  // 7. Advance used on a later invoice.
  const i5 = await vinv("2026-11-08", 2500, { billNo: "L-5" }) // ₹2,950
  await assert.rejects(api.tyrePayments.allocate(adv.id, [{ invoiceId: i5.id, amount: 2951 }]), /more than its outstanding/)
  await assert.rejects(api.tyrePayments.allocate(multi.id, [{ invoiceId: i5.id, amount: 1 }]), /no advance credit left/)
  const used = await api.tyrePayments.allocate(adv.id, [{ invoiceId: i5.id, amount: 2950 }])
  assert.deepEqual([(await payOf(i5.id)).status, unallocated(used), used.allocations.length, used.amount], ["PAID", 2050, 1, 5000], "advance applied; the payment itself unchanged")
  assert.deepEqual((await api.audit.history(adv.id)).map((e) => e.action), ["PAYMENT_RECORDED", "UPDATED"])
  // More than the total with the invoice, as explicit advance.
  const i6 = await vinv("2026-11-09", 100, { paymentMode: "UPI", billNo: "L-6", payment: { amount: 200, utr: "UPI-EXTRA", date: "2026-11-09", acceptAdvance: true } }) // ₹118
  assert.deepEqual([(await payOf(i6.id)).status, unallocated((await pays()).find((p) => p.utr === "UPI-EXTRA")!)], ["PAID", 82], "₹118 to the bill, ₹82 advance")

  // 11. Every figure reconciles.
  const acc = await account()
  const ledger = vendorLedger(await api.tyreInvoices.list(), await pays(), ven.id)
  const venInvoices = (await api.tyreInvoices.list()).filter((x) => x.supplierId === ven.id)
  assert.deepEqual([acc.purchased, acc.paid, acc.outstanding, acc.advance, acc.balance], [7552, 9684, 0, 2132, -2132], "₹7,552 bought, ₹9,684 paid, ₹2,132 advance")
  assert.equal(acc.balance, round(acc.outstanding - acc.advance), "Purchased − Paid = Outstanding − Advance")
  assert.equal(acc.purchased, round(venInvoices.reduce((t, x) => t + tyreTotals(x.items).grandTotal, 0)), "purchased = Σ invoice totals")
  const invPaid = round(venInvoices.reduce((t, x) => t + (paidByInvoice(readCollection("tyre_payments")).get(x.id) ?? 0), 0))
  assert.equal(round(invPaid + acc.advance), acc.paid, "Σ invoice paid + advance = Σ payments")
  assert.deepEqual([ledger.at(-1)!.balance, round(ledger.reduce((t, r) => t + r.credit, 0)), round(ledger.reduce((t, r) => t + r.debit, 0))], [acc.balance, acc.purchased, acc.paid], "the ledger's closing balance = Purchased − Paid")
  assert.deepEqual(ledger.slice(0, 3).map((r) => [r.date, r.kind, r.balance]), [["2026-11-01", "PURCHASE", 1180], ["2026-11-02", "PURCHASE", 1770], ["2026-11-02", "PAYMENT", 1180]], "date order, purchase before payment on a day, running balance")

  // Invoice edits never rewrite payments.
  await assert.rejects(api.tyreInvoices.update(i3.id, inv(vA.id, "2026-11-03", [line(ALIGN, 1, 100)], { supplierId: ven.id, billNo: "L-3" }), "Rate fixed"), /₹2,360.00 has already been paid against this invoice/, "total never below what was paid")
  await assert.rejects(api.tyreInvoices.update(i3.id, inv(vA.id, "2026-11-03", i3.items.map((i) => ({ ...i })), { supplierId: sup.id, billNo: "L-3" }), "Other supplier"), /supplier can't be changed/)
  await assert.rejects(api.tyreInvoices.update(i1.id, inv(vA.id, "2026-11-01", i1.items.map((i) => ({ ...i })), { supplierId: ven.id, billNo: "L-1", payment: { amount: 1, utr: "E", date: "2026-11-01" } })), /vendor's page/)
  await assert.rejects(api.tyreInvoices.remove(i3.id, "Duplicate"), /Payments are recorded against this invoice .* delete those payments first/, "an invoice with payments is never deleted")
  await api.tyreInvoices.update(i3.id, inv(vA.id, "2026-11-03", [line(ALIGN, 1, 2000), line(FITTING, 1, 50)], { supplierId: ven.id, billNo: "L-3" }), "Fitting added")
  assert.deepEqual(await payOf(i3.id), { total: 2419, paid: 2360, outstanding: 59, status: "PARTIAL" }, "a higher total: partially paid again, allocations untouched")

  // 12. Month lock, permissions, permanent delete, audit.
  const octInv = await vinv("2026-10-10", 100, { billNo: "L-OCT" }) // the Owner may enter a locked month
  setRole("EMPLOYEE")
  await assert.rejects(pay(10, "EMP-OCT", [], { date: "2026-10-31", acceptAdvance: true }), /October 2026 is locked/, "the Employee: no payment dated in a locked month")
  await assert.rejects(api.tyrePayments.allocate(adv.id, [{ invoiceId: octInv.id, amount: 118 }]), /October 2026 is locked/, "…nor settling a locked month's invoice")
  const empPay = await pay(59, "EMP-1", [{ invoiceId: i3.id, amount: 59 }])
  assert.equal((await payOf(i3.id)).status, "PAID", "the Employee records payments")
  await assert.rejects(api.tyrePayments.remove(empPay.id, "Wrong"), /can't/, "the Employee deletes no payment (the delete rule)")
  assert.ok((await pays()).some((p) => p.id === empPay.id), "…and it is still there")
  for (const role of ["TATA_ADBLUE", "ADBLUE"] as const) {
    setRole(role)
    await assert.rejects(api.tyrePayments.list().then(() => pay(1, "AB-1", [], { acceptAdvance: true })), /permission|can't/i, `${role}: no tyre payments`)
    for (const m of ["tyrePayments.list", "tyrePayments.create", "tyrePayments.allocate", "tyrePayments.remove"]) assert.equal(profileCall(role, m, async () => 1), null, `${role}: ${m} is off the method list`)
  }
  setRole("OWNER")
  await assert.rejects(api.tyrePayments.remove(multi.id, " "), /reason/)
  // Atomic: a failed audit write deletes nothing.
  failure.key = "vt:auditEvents"
  failure.once = true
  await assert.rejects(api.tyrePayments.remove(multi.id, "Bank returned the transfer"), /simulated storage failure/)
  assert.ok((await pays()).some((p) => p.id === multi.id) && (await payOf(i1.id)).status === "PAID", "a failed delete leaves the payment and its allocations")
  const multiBefore = (await pays()).find((p) => p.id === multi.id)!
  await api.tyrePayments.remove(multi.id, "Bank returned the transfer")
  assert.equal((await pays()).some((p) => p.id === multi.id), false, "deleted permanently: not in the payments any more")
  assert.equal(readCollection("tyre_payments").some((p) => p.id === multi.id), false, "…not in the store either (no voided copy)")
  assert.deepEqual([(await payOf(i1.id)).status, (await payOf(i4.id)).status], ["UNPAID", "UNPAID"], "its allocations went with it: both invoices are owed again")
  assert.equal((await pays()).some((p) => p.allocations.some((x) => x.invoiceId === i1.id || x.invoiceId === i4.id)), false, "no allocation left behind")
  assert.equal(await api.tyrePayments.remove(multi.id, "Bank returned the transfer"), undefined, "a repeated delete finds nothing…")
  assert.equal((await api.audit.history(multi.id)).filter((e) => e.action === "DELETED").length, 1, "…and records nothing")
  await assert.rejects(api.tyrePayments.allocate(multi.id, [{ invoiceId: i1.id, amount: 1 }]), /not found/)
  const again = await pay(1534, "rtgs 9", [{ invoiceId: i1.id, amount: 1180 }, { invoiceId: i4.id, amount: 354 }], { mode: "RTGS", date: "2026-11-09" })
  assert.equal((await payOf(i1.id)).status, "PAID", "re-entered (the deleted payment's reference is free again)")
  const dEvent = (await api.audit.history(multi.id)).at(-1)!
  assert.deepEqual([dEvent.action, dEvent.reason, dEvent.recordType, dEvent.before, dEvent.after ?? null], ["DELETED", "Bank returned the transfer", "Tyre payment", JSON.parse(JSON.stringify(multiBefore)), null], "the DELETED event keeps the whole payment — allocations, amounts, reference — with the reason")
  assert.ok(dEvent.actor.role === "OWNER" && !!dEvent.at && /owed again/.test(dEvent.note ?? ""), "…who, when, and which bills it freed")
  assert.equal(vendorLedger(await api.tyreInvoices.list(), await pays(), ven.id).some((r) => r.id === multi.id), false, "a deleted payment is not in the ledger")
  const restore = await api.audit.checkRestore(dEvent.id)
  assert.ok(!restore.ok && /can't be restored/.test(restore.reason), "permanent: a deleted payment is never pushed back from the audit log")
  void again

  /* ---------------------------------------------------------------- 10. "Deduct TDS?" and corrections (owner, 17 Nov 2026) */
  {
    const { allocationStatus, invoiceSettlement, settledOf, tyreTdsSplit } = await import("@/domain/tyre")
    setRole("OWNER")
    const plain = (p: object) => Object.fromEntries(Object.entries(p).filter(([k, x]) => !((k === "tdsRate" || k === "tdsAmount") && x == null)))
    const history = JSON.stringify((await pays()).map(plain)) // 18. payments recorded before this section
    const tv = await api.tyreMasters.create({ kind: "SUPPLIER", name: "TDS Tyres" })
    const tinv = (date: string, rate: number, extra: Partial<TyreInvoiceInput> = {}) => api.tyreInvoices.create(inv(vA.id, date, [line(ALIGN, 1, rate, { gstRate: 0 })], { supplierId: tv.id, ...extra }))
    const tpay = (amount: number, allocations: { invoiceId: string; amount: number }[], extra: Record<string, unknown> = {}) => api.tyrePayments.create({ date: "2026-11-09", supplierId: tv.id, amount, mode: "NEFT", utr: `T-${Math.random()}`, allocations, ...extra })
    const acct = async () => vendorAccounts(await api.tyreInvoices.list(), await pays()).find((a) => a.supplierId === tv.id)!
    const payOfT = async (id: string) => {
      const x = (await api.tyreInvoices.list()).find((i) => i.id === id)!
      return invoicePay(tyreTotals(x.items).grandTotal, paidByInvoice(await pays()).get(id) ?? 0)
    }
    const big = await tinv("2026-11-05", 100000, { billNo: "T-100K" }) // ₹1,00,000, no GST
    // 1. TDS off: exactly as before — paid = settled, no TDS.
    const off = await tpay(1000, [], { acceptAdvance: true })
    assert.deepEqual([off.amount, off.tdsAmount, off.tdsRate, settledOf(off)], [1000, 0, null, 1000], "TDS off: amount = settled")
    // 2. ₹1,00,000 at 0.1%: ₹100 TDS, ₹99,900 paid; the bill is settled in full (9) and only ₹99,900 is cash out (10).
    const b0 = await acct()
    const p01 = await tpay(100000, [{ invoiceId: big.id, amount: 100000 }], { tdsPercent: 0.1 })
    assert.deepEqual([p01.amount, p01.tdsAmount, p01.tdsRate, settledOf(p01)], [99900, 100, 0.1, 100000])
    const b1 = await acct()
    assert.deepEqual([round(b1.paid - b0.paid), round(b1.cashPaid - b0.cashPaid), round(b1.tds - b0.tds), round(b0.balance - b1.balance)], [100000, 99900, 100, 100000], "settled ₹1,00,000 = ₹99,900 cash + ₹100 TDS; the payable falls by ₹1,00,000")
    assert.deepEqual(await payOfT(big.id), { total: 100000, paid: 100000, outstanding: 0, status: "PAID" }, "the invoice is paid in full")
    assert.deepEqual(invoiceSettlement(await pays(), big.id), { settled: 100000, tds: 100, cash: 99900 }, "the invoice page's breakdown")
    // 14. TDS counted once: Paid = cash + TDS everywhere; the ledger debits the settled amount once.
    assert.equal(b1.paid, round(b1.cashPaid + b1.tds))
    const lrow = vendorLedger(await api.tyreInvoices.list(), await pays(), tv.id).find((r) => r.id === p01.id)!
    assert.deepEqual([lrow.debit, lrow.paid, lrow.tds], [100000, 99900, 100], "ledger: one debit of ₹1,00,000 (₹99,900 paid + ₹100 TDS)")
    // 3–6. 1%, custom, 0%, paise.
    assert.deepEqual(tyreTdsSplit(100000, 1), { settled: 100000, tds: 1000, paid: 99000 })
    assert.deepEqual(tyreTdsSplit(40000, 2.5), { settled: 40000, tds: 1000, paid: 39000 })
    assert.deepEqual(tyreTdsSplit(1234.56, 0.1), { settled: 1234.56, tds: 1.23, paid: 1233.33 })
    assert.deepEqual(tyreTdsSplit(1005, 0.1), { settled: 1005, tds: 1.01, paid: 1003.99 })
    const p1 = await tpay(100000, [], { tdsPercent: 1, acceptAdvance: true })
    assert.deepEqual([p1.amount, p1.tdsAmount, unallocated(p1)], [99000, 1000, 100000], "1%: ₹99,000 + ₹1,000; the advance is the full ₹1,00,000 settled")
    const p0 = await tpay(5000, [], { tdsPercent: 0, acceptAdvance: true })
    assert.deepEqual([p0.amount, p0.tdsAmount, p0.tdsRate], [5000, 0, 0], "0%: no TDS, recorded as 0%")
    // 7. Invalid %; 8. Credit with TDS — refused, nothing saved.
    const n0 = (await pays()).length
    await assert.rejects(tpay(1000, [], { tdsPercent: -0.1, acceptAdvance: true }), /can't be negative/)
    await assert.rejects(tpay(1000, [], { tdsPercent: 100, acceptAdvance: true }), /whole payment/)
    await assert.rejects(tinv("2026-11-06", 500, { paymentMode: "Credit", payment: { amount: 0, utr: "", date: "2026-11-06", tdsPercent: 0.1 } }), /Credit pays nothing now, so there is no TDS/)
    assert.equal((await pays()).length, n0)
    // Reference by mode: cheque number, receipt number.
    await assert.rejects(tpay(10, [], { mode: "Cheque", utr: " ", acceptAdvance: true }), /Enter the cheque number/)
    await assert.rejects(tpay(10, [], { mode: "Cash", utr: "", acceptAdvance: true }), /Enter the receipt number/)
    await tpay(10, [], { mode: "IMPS", utr: "IMPS-77", acceptAdvance: true })
    // Add Invoice with TDS: settled = the bill, the vendor receives the rest.
    const withTds = await tinv("2026-11-07", 1180, { billNo: "T-AI", paymentMode: "UPI", payment: { amount: 1180, utr: "UPI-T1", date: "2026-11-07", tdsPercent: 0.1 } })
    const aiPay = (await pays()).find((p) => p.utr === "UPI-T1")!
    assert.deepEqual([aiPay.amount, aiPay.tdsAmount, (await payOfT(withTds.id)).status], [1178.82, 1.18, "PAID"], "Add Invoice: ₹1,178.82 paid + ₹1.18 TDS settles the ₹1,180 bill")

    // 11. Edits recalculate everything; allocations change only when sent; a financial change needs a reason.
    const small = await tinv("2026-11-08", 20000, { billNo: "T-20K" })
    const e0 = await tpay(30000, [{ invoiceId: small.id, amount: 20000 }], { acceptAdvance: true })
    assert.deepEqual([(await payOfT(small.id)).status, unallocated(e0), allocationStatus(e0)], ["PAID", 10000, "PARTIAL"])
    const edit = (patch: Record<string, unknown>, reason?: string) => api.tyrePayments.update(e0.id, { date: "2026-11-09", amount: 30000, mode: "NEFT", utr: e0.utr, acceptAdvance: true, ...patch }, reason)
    await assert.rejects(edit({ amount: 25000, tdsPercent: 0.1 }), /Enter the reason for changing the amount, TDS/, "financial correction: reason")
    const e1 = await edit({ amount: 25000, tdsPercent: 0.1 }, "Bank charges and TDS")
    assert.deepEqual([e1.amount, e1.tdsAmount, settledOf(e1), e1.allocations, unallocated(e1)], [24975, 25, 25000, e0.allocations, 5000], "₹25,000 settled at 0.1%; the ₹20,000 on the bill kept as it was (not sent); ₹5,000 advance")
    await assert.rejects(edit({ amount: 15000, tdsPercent: 0.1 }, "Lower"), /allocations \(₹20000.00\) are more than the payment/, "never silently re-allocated: lowering below the allocations is refused")
    const e2 = await edit({ amount: 25000, tdsPercent: 0.1, allocations: [{ invoiceId: small.id, amount: 12000 }] }, "Only ₹12,000 was for T-20K")
    assert.deepEqual([(await payOfT(small.id)).outstanding, unallocated(e2), allocationStatus(e2)], [8000, 13000, "PARTIAL"], "explicit re-allocation: the bill owes ₹8,000 again; ₹13,000 advance")
    const e3 = await edit({ amount: 25000, tdsPercent: 0.1, allocations: [{ invoiceId: small.id, amount: 12000 }], notes: "Checked with the bank", utr: "NEFT-FIXED" })
    assert.deepEqual([e3.notes, e3.utr, e3.allocations], ["Checked with the bank", "NEFT-FIXED", e2.allocations], "notes / reference alone: no reason needed; same allocations kept exactly")
    await assert.rejects(edit({ amount: 25000, allocations: [{ invoiceId: big.id, amount: 1 }] }, "x y z"), /more than its outstanding ₹0.00/, "never beyond what a bill owes")
    await assert.rejects(edit({ amount: 25000, allocations: [{ invoiceId: one.id, amount: 1 }] }, "x y z"), /isn't an invoice of this vendor/)
    await assert.rejects(edit({ utr: aiPay.utr }), /Reference UPI-T1 is already recorded/, "no duplicate live reference")
    await assert.rejects(api.tyrePayments.update(e0.id, { date: "2026-11-09", amount: 25000, mode: "NEFT", utr: "X", supplierId: sup.id }), /vendor can't be changed/)
    // 17. Audit: the correction with its reason and changed fields.
    const ev = (await api.audit.history(e0.id)).find((e) => e.reason === "Only ₹12,000 was for T-20K")!
    assert.ok(ev.action === "UPDATED" && ev.changes.some((c) => c.field === "allocations") && /allocations/.test(ev.note ?? ""), "edits are audited")
    // 12 / 13. Deleting restores the bill and removes the advance; settled, cash and TDS all leave the totals and the ledger.
    const a0 = await acct()
    const tdsBefore = (await pays()).filter((p) => p.supplierId === tv.id).reduce((t, p) => round(t + (p.tdsAmount ?? 0)), 0)
    await api.tyrePayments.remove(e0.id, "Bank returned it")
    const a1 = await acct()
    assert.deepEqual([(await payOfT(small.id)).outstanding, round(a0.paid - a1.paid), round(a0.cashPaid - a1.cashPaid), round(a0.tds - a1.tds), round(a0.advance - a1.advance), round(a1.balance - a0.balance)], [20000, 25000, 24975, 25, 13000, 25000], "deleted: the bill owes ₹20,000 again; ₹25,000 settled (₹24,975 + ₹25 TDS) and ₹13,000 advance gone; the balance owed rises by ₹25,000")
    assert.equal(round(tdsBefore - (await pays()).filter((p) => p.supplierId === tv.id).reduce((t, p) => round(t + (p.tdsAmount ?? 0)), 0)), 25, "its TDS leaves the TDS totals")
    assert.equal(vendorLedger(await api.tyreInvoices.list(), await pays(), tv.id).at(-1)!.balance, a1.balance, "the ledger closes at the new balance")
    const dEv = (await api.audit.history(e0.id)).at(-1)!
    assert.deepEqual([dEv.action, (dEv.before as { tdsAmount: number }).tdsAmount, (dEv.before as { tdsRate: number }).tdsRate, (dEv.before as { allocations: unknown[] }).allocations.length], ["DELETED", 25, 0.1, 1], "the audit event keeps its TDS and allocations")
    await assert.rejects(edit({ amount: 1 }, "x y z"), /not found/, "a deleted payment can't be edited")
    // 15 / 16. Permissions and month lock.
    const oct = await tinv("2026-10-20", 500, { billNo: "T-OCT" })
    setRole("EMPLOYEE")
    const ep = await tpay(500, [], { acceptAdvance: true })
    const ep2 = await api.tyrePayments.update(ep.id, { date: "2026-11-09", amount: 600, mode: "NEFT", utr: ep.utr, acceptAdvance: true }, "Typo")
    assert.equal(ep2.amount, 600, "the Employee corrects payments (tyres:edit)")
    await assert.rejects(api.tyrePayments.remove(ep.id, "Mine"), /can't/, "…but deletes none (the delete rule)")
    await assert.rejects(api.tyrePayments.update(ep.id, { date: "2026-10-30", amount: 600, mode: "NEFT", utr: ep.utr, acceptAdvance: true }, "Back-date"), /October 2026 is locked/, "no moving a payment into a locked month")
    await assert.rejects(api.tyrePayments.update(ep.id, { date: "2026-11-09", amount: 600, mode: "NEFT", utr: ep.utr, allocations: [{ invoiceId: oct.id, amount: 500 }], acceptAdvance: true }, "Pay October"), /October 2026 is locked/, "no changing a locked month's bill")
    for (const role of ["TATA_ADBLUE", "ADBLUE"] as const) for (const m of ["tyrePayments.update", "tyrePayments.remove"]) assert.equal(profileCall(role, m, async () => 1), null, `${role}: ${m} is off the method list`)
    setRole("OWNER")
    // 18. Every payment recorded before this section is exactly as it was.
    const now = (await pays()).map(plain)
    assert.deepEqual(JSON.parse(history).map((p: { id: string }) => now.find((x) => x.id === p.id)), JSON.parse(history), "historical payments unchanged")
  }

  console.log("tyre data: masters, invoice lines and amounts (CGST / SGST / IGST, paise), company from the assignment, validation, atomic failure, edit, month lock, permissions, delete / restore, filters, the Monthly Sheet and the current-month Tyre page (month, year and FY changes), vendor payments (credit / full / partial / instalments / several invoices / advance and its use, UTR rules, reconciliation, edits, permanent delete, month lock, permissions, audit), TDS on payments, corrections and deletion: all checks passed")
}

const round = (n: number) => Math.round(n * 100) / 100

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
